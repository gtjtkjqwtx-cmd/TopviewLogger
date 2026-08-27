/**
 * CountIf.net Authentication Proxy Server
 * 
 * This lightweight Express server acts as a secure intermediary between
 * the Topview Logger client app and the CountIf.net ASP.NET backend.
 * It handles the full ASP.NET WebForms login dance:
 *   1. GET the login page to harvest __VIEWSTATE and hidden fields
 *   2. POST credentials with the harvested hidden fields
 *   3. Return the authentication result and session cookies
 *
 * Also provides a transparent reverse proxy for Samsara authentication,
 * allowing users to log in via their real browser.
 */

import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import zlib from 'zlib';

let samsaraSessionCookies = null;
let samsaraCsrfToken = null;
let samsaraAuthActive = false;
let samsaraCapturedCookies = {};

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ============================================================
// COUNTIF.NET LOGIN ENDPOINT
// ============================================================

app.post('/api/countif/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false, 
      stage: 'validation',
      message: 'Username and password are required.' 
    });
  }

  const LOGIN_URL = 'https://www.countif.net/Account/Login.aspx';
  const stages = [];

  try {
    // ── Stage 1: Fetch login page to harvest ASP.NET hidden fields ──
    stages.push({ stage: 'init', message: 'Initiating secure connection...', timestamp: Date.now() });

    const pageRes = await fetch(LOGIN_URL, {
      method: 'GET',
      headers: {
        'User-Agent': 'TopviewLogger/10.0',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    if (!pageRes.ok) {
      throw new Error(`Login page returned HTTP ${pageRes.status}`);
    }

    const pageHtml = await pageRes.text();
    stages.push({ stage: 'page_loaded', message: 'Login page loaded. Harvesting tokens...', timestamp: Date.now() });

    // Extract cookies from the initial GET
    const initialCookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
    const cookieString = initialCookies.map(c => c.split(';')[0]).join('; ');

    // ── Stage 2: Parse hidden fields ──
    const viewstate = extractHiddenField(pageHtml, '__VIEWSTATE');
    const eventTarget = extractHiddenField(pageHtml, '__EVENTTARGET') || '';
    const eventArgument = extractHiddenField(pageHtml, '__EVENTARGUMENT') || '';
    const viewstateGen = extractHiddenField(pageHtml, '__VIEWSTATEGENERATOR') || '';
    const eventValidation = extractHiddenField(pageHtml, '__EVENTVALIDATION') || '';

    if (!viewstate) {
      throw new Error('Failed to harvest __VIEWSTATE token from login page.');
    }

    stages.push({ stage: 'tokens_harvested', message: 'Security tokens acquired. Authenticating...', timestamp: Date.now() });

    // ── Stage 3: Submit login form ──
    const formParams = new URLSearchParams();
    formParams.append('__EVENTTARGET', eventTarget);
    formParams.append('__EVENTARGUMENT', eventArgument);
    formParams.append('__VIEWSTATE', viewstate);
    if (viewstateGen) formParams.append('__VIEWSTATEGENERATOR', viewstateGen);
    if (eventValidation) formParams.append('__EVENTVALIDATION', eventValidation);
    formParams.append('ctl00$MainContent$LoginUser$UserName', username);
    formParams.append('ctl00$MainContent$LoginUser$Password', password);
    formParams.append('ctl00$MainContent$LoginUser$LoginButton', 'Log In');

    const loginRes = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'TopviewLogger/10.0',
        'Cookie': cookieString,
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': LOGIN_URL
      },
      body: formParams.toString(),
      redirect: 'manual'  // Don't auto-follow redirects so we can inspect them
    });

    // ── Stage 4: Evaluate result ──
    const statusCode = loginRes.status;
    const locationHeader = loginRes.headers.get('location') || '';
    const authCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    
    // ASP.NET typically returns 302 redirect on successful login
    const hasAuthCookie = authCookies.some(c => 
      c.includes('.ASPXAUTH') || c.includes('.AspNet') || c.includes('ASPXFORMSAUTH')
    );
    const isRedirectToHome = (statusCode === 302 || statusCode === 301) && 
      !locationHeader.toLowerCase().includes('login');

    if (isRedirectToHome || hasAuthCookie) {
      stages.push({ stage: 'authenticated', message: 'Authentication successful!', timestamp: Date.now() });

      // Combine and return all cookies for persistence
      const sessionCookies = authCookies.map(c => c.split(';')[0]).join('; ');

      return res.json({
        success: true,
        stages,
        result: {
          status: statusCode,
          redirectTo: locationHeader,
          sessionCookie: sessionCookies,
          message: 'Successfully authenticated to CountIf.net'
        }
      });
    } else {
      // Login failed — check the response body for error messages
      const bodyText = await loginRes.text();
      const errorMatch = bodyText.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)/i) ||
                         bodyText.match(/validation-summary[^>]*>.*?<li>([^<]+)/is);
      const errorMsg = errorMatch ? errorMatch[1].trim() : 'Invalid username or password.';
      
      stages.push({ stage: 'auth_failed', message: errorMsg, timestamp: Date.now() });

      return res.json({
        success: false,
        stages,
        result: {
          status: statusCode,
          message: errorMsg
        }
      });
    }

  } catch (err) {
    stages.push({ stage: 'error', message: err.message, timestamp: Date.now() });
    return res.status(500).json({
      success: false,
      stages,
      result: {
        message: err.message
      }
    });
  }
});

// ============================================================
// COUNTIF.NET DISPATCH DATA SCRAPER
// ============================================================

import * as cheerio from 'cheerio';

let dispatchServerCache = {
  data: null,
  timestamp: 0,
  cookie: null
};

app.get('/api/countif/dispatch', async (req, res) => {
  const sessionCookie = req.query.cookie;

  if (!sessionCookie) {
    return res.status(401).json({ success: false, message: 'No session cookie provided.' });
  }

  // Fast-path: return cached response if fetched within last 10 seconds for same session
  if (dispatchServerCache.data && 
      dispatchServerCache.cookie === sessionCookie && 
      (Date.now() - dispatchServerCache.timestamp < 10000)) {
    return res.json({ 
      success: true, 
      count: dispatchServerCache.data.length, 
      data: dispatchServerCache.data, 
      cached: true 
    });
  }

  const REPORT_URL = 'https://www.countif.net/Administration/Reports/DispatchReport.aspx';

  try {
    // 1. Initial GET to fetch the form and ViewState tokens
    const reportRes = await fetch(REPORT_URL, {
      method: 'GET',
      headers: {
        'User-Agent': 'TopviewLogger/11.3',
        'Cookie': sessionCookie,
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': REPORT_URL
      }
    });

    if (!reportRes.ok) {
        if (reportRes.status === 302 || reportRes.status === 301) {
            return res.status(401).json({ success: false, message: 'Session expired.' });
        }
        throw new Error(`Report page returned HTTP ${reportRes.status}`);
    }

    const html = await reportRes.text();
    if (html.includes('LoginUser') || html.includes('Log In')) {
        return res.status(401).json({ success: false, message: 'Session expired or invalid.' });
    }

    // 2. Extract form parameters securely using Cheerio
    const $ = cheerio.load(html);
    const params = new URLSearchParams();
    
    $('input, select, textarea').each((i, el) => {
        const name = $(el).attr('name');
        const value = $(el).val() || '';
        const type = $(el).attr('type');
        
        if (name && type !== 'submit' && type !== 'button') {
            if (name === 'ctl00$MainContent$ddlPageSize') {
                params.append(name, ''); // 'All' value
                return;
            }
            if ($(el).is('select') && $(el).attr('multiple')) {
                 if (name === 'ctl00$MainContent$lstDispatchTypes') {
                     ['1','101','2','3','4','104','7','8','9'].forEach(t => params.append(name, t));
                 } else {
                     $(el).find('option[selected]').each((j, opt) => params.append(name, $(opt).attr('value')));
                 }
                 return;
            }
            if ($(el).is('select') && !$(el).attr('multiple')) {
                const selectedVal = $(el).find('option[selected]').attr('value') || $(el).find('option').first().attr('value') || '';
                params.append(name, selectedVal);
                return;
            }
            params.append(name, value);
        }
    });
    
    // Force 'All' records (overrides any default 100 selection)
    params.set('ctl00$MainContent$ddlPageSize', ''); 
    
    params.append('ctl00$MainContent$btnSearch', 'Search');
    params.delete('__EVENTTARGET');
    params.delete('__EVENTARGUMENT');
    params.append('__EVENTTARGET', '');
    params.append('__EVENTARGUMENT', '');

    // 3. POST the constructed form to trigger the GridView generation
    const postRes = await fetch(REPORT_URL, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'TopviewLogger/11.3'
      },
      body: params.toString()
    });
    
    const postHtml = await postRes.text();
    const $post = cheerio.load(postHtml);
    
    const rows = [];
    $post('#MainContent_gvResults tr').each((i, row) => {
        if (i === 0) return; // Skip Header
        
        const cells = $post(row).find('td, th');
        if (cells.length >= 6) {
            rows.push({
                date: $post(cells[0]).text().trim(),
                user: $post(cells[1]).text().trim(),
                bus: $post(cells[2]).text().trim(),
                operator: $post(cells[3]).text().trim(),
                route: $post(cells[4]).text().trim(),
                stop: $post(cells[5]).text().trim()
            });
        }
    });

    dispatchServerCache = {
      data: rows,
      timestamp: Date.now(),
      cookie: sessionCookie
    };

    return res.json({
        success: true,
        count: rows.length,
        data: rows
    });

  } catch (err) {
    console.error('[DispatchScraper] Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// SAMSARA SECURE TUNNEL (For Native IPA)
// ============================================================

app.get('/api/samsara/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const apiKey = req.query.key;

  if (!targetUrl || !apiKey) {
    return res.status(400).json({ success: false, message: 'URL and Key are required.' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for cold starts

    const samsaraRes = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'User-Agent': 'TopviewLogger/10.0'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const contentType = samsaraRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await samsaraRes.json();
      return res.status(samsaraRes.status).json(data);
    } else {
      // If Samsara returns HTML (like a maintenance page), pass the text through
      const textData = await samsaraRes.text();
      console.warn('[SamsaraTunnel] Non-JSON response received from Samsara.');
      return res.status(samsaraRes.status).send(textData);
    }
  } catch (err) {
    console.error('[SamsaraTunnel] Proxy Crash:', err);
    return res.status(502).json({ success: false, message: 'Tunnel failed to reach Samsara: ' + err.message });
  }
});

// ============================================================
// SAMSARA BROWSER AUTH PROXY
// ============================================================

// Status endpoint - frontend polls this to check if login succeeded
app.get('/api/samsara/status', (req, res) => {
  const cookieString = Object.values(samsaraCapturedCookies).join('; ');
  res.json({
    connected: Boolean(samsaraSessionCookies && samsaraCsrfToken),
    loginDetected: samsaraAuthActive === false && Object.keys(samsaraCapturedCookies).length > 0,
    cookies: samsaraSessionCookies || (Object.keys(samsaraCapturedCookies).length > 0 ? cookieString : null),
    csrfToken: samsaraCsrfToken
  });
});

// Start the auth flow - enables the reverse proxy
app.get('/api/samsara/auth-start', (req, res) => {
  samsaraAuthActive = true;
  samsaraCapturedCookies = {};
  samsaraCsrfToken = null;
  samsaraSessionCookies = null;
  console.log('[SamsaraAuth] Auth flow started. Proxy activated.');
  res.json({ success: true, loginUrl: '/signin' });
});

// Success page - shown after login redirect is detected
app.get('/samsara-auth-success', (req, res) => {
  samsaraAuthActive = false;
  const cookieString = Object.values(samsaraCapturedCookies).join('; ');
  samsaraSessionCookies = cookieString;
  console.log('[SamsaraAuth] Auth complete. Cookies captured:', Object.keys(samsaraCapturedCookies).length);
  console.log('[SamsaraAuth] CSRF token:', samsaraCsrfToken);
  res.send(`<!DOCTYPE html><html><head><title>Connected</title></head>
<body style="background:#0a0e14;color:#2ecc71;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;">
<h1 style="font-size:3rem;margin-bottom:0.5rem;">&#x2705;</h1>
<h2>Samsara Connected!</h2>
<p style="color:#8899aa;font-size:0.9rem;">You can close this window now.</p>
<script>
if(window.opener){window.opener.postMessage({type:'samsara-auth-success'},'*');}
setTimeout(()=>window.close(),2000);
</script></body></html>`);
});

// Reset auth state
app.post('/api/samsara/auth-reset', (req, res) => {
  samsaraAuthActive = false;
  samsaraCapturedCookies = {};
  samsaraCsrfToken = null;
  samsaraSessionCookies = null;
  console.log('[SamsaraAuth] Session reset.');
  res.json({ success: true });
});

app.post('/api/samsara/fleet', async (req, res) => {
  const cookies = req.body.cookies || samsaraSessionCookies;
  const csrf = req.body.csrfToken || samsaraCsrfToken;
  const filterText = req.body.filterText || '';

  if (!cookies || !csrf) {
    return res.status(401).json({ success: false, message: 'Not connected to Samsara. Please login first.' });
  }

  const query = `
    fragment MapAsset on Asset {
      uuid
      name
      lastLocation {
        lat
        lng
      }
      status
      isRunning
      addressEntry {
        name
        types
      }
    }

    query FleetListPage($orgId: int64!, $first: Int, $filterText: String, $assetTypes: [String!], $sortBy: String, $sortOrder: String, $isActivated: Boolean) {
      assets(orgId: $orgId, first: $first, filterText: $filterText, assetTypes: $assetTypes, sortBy: $sortBy, sortOrder: $sortOrder, isActivated: $isActivated) {
        nodes {
          ...MapAsset
        }
      }
    }
  `;

  const variables = {
    orgId: 6003359,
    assetTypes: ["Vehicle"],
    first: 500,
    filterText: filterText,
    sortBy: "inMotion",
    sortOrder: "desc",
    isActivated: true
  };

  try {
    const graphRes = await fetch('https://us6-ws.cloud.samsara.com/r/graphql?q=FleetListPage', {
      method: 'POST',
      headers: {
        'Cookie': cookies,
        'X-Csrf-Token': csrf,
        'Content-Type': 'application/json',
        'Origin': 'https://cloud.samsara.com',
        'Referer': 'https://cloud.samsara.com/o/6003359/fleet/list',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'
      },
      body: JSON.stringify({ query, variables })
    });

    if (!graphRes.ok) {
      if (graphRes.status === 401 || graphRes.status === 403) {
        samsaraSessionCookies = null;
        samsaraCsrfToken = null;
        return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
      }
      throw new Error(`Samsara GraphQL HTTP ${graphRes.status}`);
    }

    const json = await graphRes.json();
    if (json.errors && json.errors.length > 0) {
      console.warn('[SamsaraFleet] GraphQL Errors:', json.errors);
    }

    const nodes = json.data?.assets?.nodes || [];
    const vehicles = nodes.map(v => ({
      id: v.uuid || v.name,
      name: v.name || 'Unknown',
      latitude: v.lastLocation?.lat || 0,
      longitude: v.lastLocation?.lng || 0,
      heading: 0,
      speed: v.isRunning ? 15 : 0,
      isRunning: Boolean(v.isRunning),
      status: v.status || 'unknown',
      address: v.addressEntry?.name || 'Unknown Address',
      time: new Date().toISOString()
    }));

    return res.json({ success: true, vehicles, count: vehicles.length });
  } catch (err) {
    console.error('[SamsaraFleet] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch fleet data: ' + err.message });
  }
});

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', service: 'countif-proxy', version: '11.0.0-authproxy' });
});

// ── Utility: Extract hidden field value from HTML ──
function extractHiddenField(html, fieldName) {
  // Match both single and double quoted value attributes
  const regex = new RegExp(`name="${fieldName}"[^>]*value="([^"]*)"`, 'i');
  const match = html.match(regex);
  if (match) return match[1];
  
  // Try alternate order (value before name)
  const regex2 = new RegExp(`value="([^"]*)"[^>]*name="${fieldName}"`, 'i');
  const match2 = html.match(regex2);
  return match2 ? match2[1] : null;
}

// ============================================================
// SAMSARA REVERSE PROXY (catch-all - MUST be registered last)
// ============================================================

// Helper: strip security headers that block rendering through the proxy
function stripSecurityHeaders(proxyRes) {
  delete proxyRes.headers['x-frame-options'];
  delete proxyRes.headers['content-security-policy'];
  delete proxyRes.headers['content-security-policy-report-only'];
  delete proxyRes.headers['strict-transport-security'];
  delete proxyRes.headers['x-content-type-options'];
}

// Helper: capture and rewrite Set-Cookie headers from Samsara
function captureCookies(proxyRes) {
  const setCookieHeaders = proxyRes.headers['set-cookie'];
  if (setCookieHeaders) {
    const rewritten = setCookieHeaders.map(cookie => {
      const nameMatch = cookie.match(/^([^=]+)=([^;]*)/);
      if (nameMatch) {
        const key = nameMatch[1].trim();
        const val = nameMatch[2];
        samsaraCapturedCookies[key] = key + '=' + val;
        console.log('[SamsaraAuth] Captured cookie:', key);
        if (/csrf|xsrf/i.test(key)) {
          samsaraCsrfToken = val;
          console.log('[SamsaraAuth] Captured CSRF from cookie:', key, '=', val);
        }
      }
      return cookie
        .replace(/;\s*Secure/gi, '')
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*SameSite=None/gi, '; SameSite=Lax');
    });
    proxyRes.headers['set-cookie'] = rewritten;
  }
}

// Helper: rewrite Location headers to stay within the proxy
function rewriteLocationHeader(proxyRes) {
  const location = proxyRes.headers['location'];
  if (!location) return;

  // Distinguish intermediate login/auth steps from actual post-login destinations
  const isIntermediateAuth = /\/(signin|login|saml|auth|select_org|choose_org|oci_oidc)\b/i.test(location);
  const isPostLogin = /\/(fleet|dashboard|d\/|organizations\/list)\b/i.test(location) || (/\/o\/\d+/i.test(location) && !isIntermediateAuth);

  if (isPostLogin && !isIntermediateAuth) {
    console.log('[SamsaraAuth] Login completion redirect detected:', location);
    proxyRes.headers['location'] = '/samsara-auth-success';
    return;
  }

  // Rewrite absolute Samsara URLs to stay within proxy
  let rewritten = location;
  rewritten = rewritten.replace(/https?:\/\/cloud\.samsara\.com/gi, '');
  rewritten = rewritten.replace(/https?:\/\/[a-z0-9-]+\.cloud\.samsara\.com/gi, '');
  if (rewritten.includes('origin=')) {
    rewritten = rewritten.replace(/origin=https?(%3A%2F%2F|:\/\/)[^&]+/gi, 'origin=https%3A%2F%2Fcloud.samsara.com');
  }
  if (rewritten !== location) {
    console.log('[SamsaraAuth] Rewrote redirect:', location, '->', rewritten);
    proxyRes.headers['location'] = rewritten;
  }
}

// Helper: forward accumulated browser cookies to Samsara
function forwardCookies(proxyReq, req) {
  // Merge browser cookies with any we've captured server-side
  const browserCookies = req.headers.cookie || '';
  const serverCookies = Object.values(samsaraCapturedCookies).join('; ');
  const merged = [browserCookies, serverCookies].filter(Boolean).join('; ');
  if (merged) {
    proxyReq.setHeader('Cookie', merged);
  }
}

// Helper: rewrite HTML content to route Samsara URLs through our proxy
function rewriteSamsaraHtml(html) {
  let result = html;

  // Inject client-side fetch/XHR patch for origin param and neutralize framebusting
  const originPatch = `<script>
(function(){
  try {
    // Neutralize anti-iframe checks so the login screen stays rendered
    Object.defineProperty(window, 'top', { get: function() { return window.self; } });
    Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
    Object.defineProperty(window, 'frameElement', { get: function() { return null; } });
  } catch(e) {}

  function fixUrl(u){
    if(typeof u==='string' && u.includes('origin=')){
      return u.replace(/origin=https?(%3A%2F%2F|:\\\/\\\/)[^&]+/gi, 'origin=https%3A%2F%2Fcloud.samsara.com');
    }
    return u;
  }
  const of=window.fetch;
  if(of){
    window.fetch=function(i,n){
      if(typeof i==='string') i=fixUrl(i);
      else if(i && i.url){ try{ i=new Request(fixUrl(i.url), i); }catch(e){} }
      return of.call(this,i,n);
    };
  }
  const ox=XMLHttpRequest.prototype.open;
  if(ox){
    XMLHttpRequest.prototype.open=function(m,u){
      if(typeof u==='string') u=fixUrl(u);
      return ox.apply(this,arguments);
    };
  }
})();
</script>`;

  if (result.includes('<head>')) {
    result = result.replace('<head>', '<head>' + originPatch);
  }

  // Rewrite static asset subdomains
  result = result.replace(/https?:\/\/static\.cloud\.samsara\.com/gi, '/static-proxy');
  result = result.replace(/https?:\/\/static\.samsara\.com/gi, '/static-proxy');
  // Rewrite regional/WS/GraphQL subdomains (*.cloud.samsara.com except static) → /ws-proxy/
  result = result.replace(/https?:\/\/([a-z0-9-]+)\.cloud\.samsara\.com/gi, (match, sub) => {
    if (sub === 'static') return '/static-proxy';
    return `/ws-proxy/${sub}`;
  });
  // Rewrite absolute URLs to cloud.samsara.com → relative (stays in our proxy)
  result = result.replace(/https?:\/\/cloud\.samsara\.com/gi, '');
  return result;
}

// ── Subdomain proxy: static.cloud.samsara.com ──
const staticSamsaraProxy = createProxyMiddleware({
  target: 'https://static.cloud.samsara.com',
  changeOrigin: true,
  secure: true,
  pathRewrite: { '^/static-proxy': '' },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.setHeader('Host', 'static.cloud.samsara.com');
    },
    proxyRes: (proxyRes) => {
      stripSecurityHeaders(proxyRes);
    }
  }
});
app.use('/static-proxy', (req, res, next) => {
  if (samsaraAuthActive) return staticSamsaraProxy(req, res, next);
  next();
});

// ── Subdomain proxy: *.cloud.samsara.com (WebSocket/GraphQL) ──
// Handles paths like /ws-proxy/us6-ws/r/graphql
app.use('/ws-proxy', (req, res, next) => {
  if (!samsaraAuthActive) return next();

  // Extract the subdomain from the path: /ws-proxy/us6-ws/r/graphql → subdomain=us6-ws
  const pathParts = req.url.split('/').filter(Boolean);
  const subdomain = pathParts[0];
  if (!subdomain) return next();

  const target = `https://${subdomain}.cloud.samsara.com`;
  const remainingPath = '/' + pathParts.slice(1).join('/');
  req.url = remainingPath;

  const wsProxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    secure: true,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('Host', `${subdomain}.cloud.samsara.com`);
        proxyReq.setHeader('Origin', 'https://cloud.samsara.com');
        proxyReq.setHeader('Referer', 'https://cloud.samsara.com/');
        if (proxyReq.path && proxyReq.path.includes('origin=')) {
          proxyReq.path = proxyReq.path.replace(/origin=https?(%3A%2F%2F|:\/\/)[^&]+/gi, 'origin=https%3A%2F%2Fcloud.samsara.com');
        }
        forwardCookies(proxyReq, req);
        const csrf = req.headers['x-csrf-token'] || req.headers['csrf-token'];
        if (csrf) {
          samsaraCsrfToken = csrf;
          console.log('[SamsaraAuth] Captured CSRF from ws-proxy:', csrf);
        }
      },
      proxyRes: (proxyRes) => {
        stripSecurityHeaders(proxyRes);
        captureCookies(proxyRes);
      }
    }
  });
  return wsProxy(req, res, next);
});

// ── Main Samsara proxy (cloud.samsara.com) with HTML rewriting & decompression ──
const samsaraProxy = createProxyMiddleware({
  target: 'https://cloud.samsara.com',
  changeOrigin: true,
  secure: true,
  ws: true,
  selfHandleResponse: true, // We intercept responses to rewrite HTML/JS
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.setHeader('Host', 'cloud.samsara.com');
      proxyReq.setHeader('Origin', 'https://cloud.samsara.com');
      proxyReq.setHeader('Referer', 'https://cloud.samsara.com/');
      proxyReq.setHeader('Accept-Encoding', 'identity'); // Request uncompressed output where possible

      if (proxyReq.path && proxyReq.path.includes('origin=')) {
        const oldPath = proxyReq.path;
        proxyReq.path = proxyReq.path.replace(/origin=https?(%3A%2F%2F|:\/\/)[^&]+/gi, 'origin=https%3A%2F%2Fcloud.samsara.com');
        console.log('[SamsaraAuth] Rewrote origin query param in path:', oldPath, '->', proxyReq.path);
      }

      forwardCookies(proxyReq, req);
      const csrf = req.headers['x-csrf-token'] || req.headers['csrf-token'] || req.headers['x-xsrf-token'];
      if (csrf) {
        samsaraCsrfToken = csrf;
        console.log('[SamsaraAuth] Captured CSRF token:', csrf);
      } else if (samsaraCsrfToken) {
        proxyReq.setHeader('X-Csrf-Token', samsaraCsrfToken);
        proxyReq.setHeader('X-Xsrf-Token', samsaraCsrfToken);
        console.log('[SamsaraAuth] Injected captured CSRF token:', samsaraCsrfToken);
      }
    },
    proxyRes: (proxyRes, req, res) => {
      stripSecurityHeaders(proxyRes);
      captureCookies(proxyRes);
      rewriteLocationHeader(proxyRes);

      const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isHtmlOrJs = contentType.includes('text/html') || contentType.includes('javascript');

      if (isHtmlOrJs) {
        const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          let rawBuffer = Buffer.concat(chunks);
          if (encoding.includes('gzip')) {
            try { rawBuffer = zlib.gunzipSync(rawBuffer); } catch(e) { console.error('[SamsaraAuth] Gunzip failed:', e.message); }
          } else if (encoding.includes('deflate')) {
            try { rawBuffer = zlib.inflateSync(rawBuffer); } catch(e) { console.error('[SamsaraAuth] Inflate failed:', e.message); }
          } else if (encoding.includes('br')) {
            try { rawBuffer = zlib.brotliDecompressSync(rawBuffer); } catch(e) { console.error('[SamsaraAuth] Brotli decompress failed:', e.message); }
          }

          let body = rawBuffer.toString('utf8');
          body = rewriteSamsaraHtml(body);

          const headers = { ...proxyRes.headers };
          delete headers['content-length'];
          delete headers['content-encoding'];
          res.writeHead(proxyRes.statusCode, headers);
          res.end(body);
        });
      } else {
        // Non-HTML/JS: pass through as-is (images, fonts, JSON, etc.)
        const headers = { ...proxyRes.headers };
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      }
    }
  }
});

// Internal server endpoints that must NOT be passed to Samsara proxy
const INTERNAL_API_PREFIXES = ['/api/samsara/', '/api/countif/', '/api/health', '/samsara-auth-success', '/static-proxy', '/ws-proxy'];

// Catch-all: proxy requests to Samsara when auth is active (excluding our internal endpoints)
app.use((req, res, next) => {
  if (samsaraAuthActive) {
    const isInternal = INTERNAL_API_PREFIXES.some(prefix => req.originalUrl.startsWith(prefix));
    if (!isInternal) {
      return samsaraProxy(req, res, next);
    }
  }
  next();
});

app.listen(PORT, () => {
  console.log(`[CountIf Proxy] Online at http://localhost:${PORT}`);
  console.log(`[CountIf Proxy] POST /api/countif/login`);
  console.log(`[CountIf Proxy] GET  /api/samsara/auth-start -> opens browser login`);
  console.log(`[CountIf Proxy] GET  /api/health`);
});
