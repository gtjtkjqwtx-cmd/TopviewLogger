/**
 * Samsara Telemetry Engine
 * 
 * This module fetches real-time GPS coordinates directly from the Samsara Vehicle Stats API
 * and geometrically resolves them against a static list of physical stops to determine
 * the closest LAST VISITED stop vs the exact NEXT UPCOMING stop without relying 
 * on complex route polygons.
 */

/**
 * SAMSARA CONFIGURATION
 * ------------------------------------------------------------
 * 1. Insert your API Key below.
 * 2. Update the latitude and longitude for each of the 23 stops.
 */
const SAMSARA_CONFIG = {
  API_KEY: 'PASTE_YOUR_SAMSARA_API_KEY_HERE',
  STOPS: [
    { "id": 1, "name": "Stop 01", "lat": 40.759433036950966, "lng": -73.98454271585518 },
    { "id": 2, "name": "Stop 02", "lat": 40.7551337, "lng": -73.9878992 },
    { "id": 3, "name": "Stop 03", "lat": 40.7540893569216, "lng": -73.98240036497312 },
    { "id": 4, "name": "Stop 04", "lat": 40.74948665445104, "lng": -73.98400743844203 },
    { "id": 5, "name": "Stop 05", "lat": 40.74124988195435, "lng": -73.98986219295237 },
    { "id": 6, "name": "Stop 06", "lat": 40.72274571331615, "lng": -73.99935832990472 },
    { "id": 7, "name": "Stop 07", "lat": 40.7181918, "lng": -74.00303760489153 },
    { "id": 8, "name": "Stop 08", "lat": 40.71287778281122, "lng": -74.00761735246677 },
    { "id": 9, "name": "Stop 09", "lat": 40.70485523333685, "lng": -74.0145540134917 },
    { "id": 10, "name": "Stop 10", "lat": 40.71744280723422, "lng": -74.01266527299902 },
    { "id": 11, "name": "Stop 11", "lat": 40.728250369455836, "lng": -74.01055839970415 },
    { "id": 12, "name": "Stop 12", "lat": 40.75470897188512, "lng": -74.00641577135055 },
    { "id": 13, "name": "Stop 13", "lat": 40.761713808732345, "lng": -74.0007794063889 },
    { "id": 14, "name": "Stop 14", "lat": 40.758033819326194, "lng": -73.98907964773709 },
    { "id": 15, "name": "Stop 15", "lat": 40.7601836, "lng": -73.9874334 },
    { "id": 16, "name": "Stop 16", "lat": 40.776564036598295, "lng": -73.97567436826684 },
    { "id": 17, "name": "Stop 17", "lat": 40.781254188344924, "lng": -73.972319676628 },
    { "id": 18, "name": "Stop 18", "lat": 40.79280713927449, "lng": -73.95224754745723 },
    { "id": 19, "name": "Stop 19", "lat": 40.78358504626594, "lng": -73.95898904334892 },
    { "id": 20, "name": "Stop 20", "lat": 40.779910469854684, "lng": -73.96167300597553 },
    { "id": 21, "name": "Stop 21", "lat": 40.76826722798106, "lng": -73.9701455132616 },
    { "id": 22, "name": "Stop 22", "lat": 40.765145593895625, "lng": -73.98037615495919 },
    { "id": 23, "name": "Stop 23", "lat": 40.76127825073647, "lng": -73.98318299967468 }
  ]
};

class SamsaraEngine {
  
  static get CONFIG() {
    return SAMSARA_CONFIG;
  }
  
  static get PROXY_BASE() {
    // Always route to live Render proxy (matching COUNTIF_PROXY_URL) unless local testing is explicitly enabled
    return (typeof window !== 'undefined' && window.USE_LOCAL_PROXY) ? 'http://localhost:3001' : 'https://topviewloggerr.onrender.com';
  }

  static async proxyRequest(endpoint, body = {}) {
    const cookies = typeof localStorage !== 'undefined' ? localStorage.getItem('samsara_session_cookies') : null;
    const csrfToken = typeof localStorage !== 'undefined' ? localStorage.getItem('samsara_csrf_token') : null;
    const payload = { ...body };
    if (cookies && !payload.cookies) payload.cookies = cookies;
    if (csrfToken && !payload.csrfToken) payload.csrfToken = csrfToken;

    const url = `${this.PROXY_BASE}${endpoint}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve({ success: true }); }
        } else {
          try {
            const errJson = JSON.parse(xhr.responseText);
            reject(new Error(errJson.message || `HTTP ${xhr.status}`));
          } catch(e) {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        }
      };
      xhr.onerror = () => reject(new Error('Network/CORS block reaching proxy'));
      xhr.timeout = 35000;
      xhr.ontimeout = () => reject(new Error('Proxy connection timed out'));
      xhr.send(JSON.stringify(payload));
    });
  }

  /**
   * Fetches the raw GPS state of a specific vehicle from the Samsara platform via Proxy.
   * @param {string} vehicleId - The specific Samsara ID of the bus
   * @returns {Promise<{latitude: number, longitude: number, heading: number, speed: number}>}
   */
  static async fetchBusLocation(vehicleId) {
    try {
      const res = await this.proxyRequest('/api/samsara/fleet', { filterText: vehicleId });
      if (!res.success || !res.vehicles || res.vehicles.length === 0) {
        throw new Error('Bus not found or offline');
      }
      const searchId = (vehicleId || '').trim().toLowerCase();
      const match = res.vehicles.find(v => (v.name || '').trim().toLowerCase() === searchId) || res.vehicles[0];
      
      return {
        latitude: match.latitude,
        longitude: match.longitude,
        heading: match.heading || 0,
        speed: match.speed || 0,
        time: match.time || new Date().toISOString(),
        address: match.address || 'Unknown Street'
      };
    } catch (e) {
      console.error('[SamsaraEngine] fetchBusLocation failed:', e);
      throw e;
    }
  }

  /**
   * Calculates the Haversine great-circle distance between two earth coordinates.
   */
  static getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; 
  }

  /**
   * Calculates the Vector Bearing (Angle) from A to B.
   */
  static getBearingDegrees(startLat, startLng, destLat, destLng) {
    const startLatRad = startLat * Math.PI / 180;
    const startLngRad = startLng * Math.PI / 180;
    const destLatRad = destLat * Math.PI / 180;
    const destLngRad = destLng * Math.PI / 180;

    const y = Math.sin(destLngRad - startLngRad) * Math.cos(destLatRad);
    const x = Math.cos(startLatRad) * Math.sin(destLatRad) -
              Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(destLngRad - startLngRad);
              
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360; 
  }

  /**
   * Compares the bus telemetry against all known stops.
   * Returns human-readable nearest stop and the next upcoming stop.
   * 
   * @param {Object} busGps - { latitude, longitude, heading }
   * @param {Array} routeStops - Array of objects with at least: { name, lat, lng }
  /**
   * Compares the bus telemetry against known stops using Orbital Route Logic.
   * Segments stops into Downtown (1-14) and Uptown (15-23) loops.
   * 
   * @param {Object} busGps - { latitude, longitude, heading }
   * @param {Array} routeStops - Array of objects with at least: { id, name, lat, lng }
   */
  static resolveRouteContext(busGps, routeStops) {
    // 1. First, find the ABSOLUTE closest stop to determine the current Route Cluster
    const allStopsWithDist = routeStops.map(stop => ({
      ...stop,
      distanceMeters: this.getDistanceMeters(busGps.latitude, busGps.longitude, stop.lat, stop.lng)
    }));
    
    allStopsWithDist.sort((a, b) => a.distanceMeters - b.distanceMeters);
    const absoluteClosest = allStopsWithDist[0];
    
    // 2. Identify active cluster (Downtown 1-14 vs Uptown 15-23)
    // Using ID ranges as the source of truth for the loop
    const isDowntown = absoluteClosest.id <= 14;
    const activeCluster = isDowntown 
      ? allStopsWithDist.filter(s => s.id <= 14)
      : allStopsWithDist.filter(s => s.id > 14);

    console.log(`[RouteEngine] Detected Loop: ${isDowntown ? 'DOWNTOWN' : 'UPTOWN'} (Locked to ${activeCluster.length} nodes)`);

    // 3. Resolve Last/Upcoming based ONLY on the active cluster
    let analyzedStops = activeCluster.map(stop => {
      const bearingToStop = this.getBearingDegrees(busGps.latitude, busGps.longitude, stop.lat, stop.lng);
      
      // Calculate angular drift
      let angleDiff = Math.abs(busGps.heading - bearingToStop);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      
      // Geometric "Behind" check
      const isBehind = angleDiff > 90; 

      return { 
        ...stop, 
        bearingToStop: bearingToStop,
        isBehind: isBehind 
      };
    });

    // 4. Extract context
    // Sort within cluster by distance to ensure we find the closest one ahead/behind
    analyzedStops.sort((a, b) => a.distanceMeters - b.distanceMeters);
    
    const lastVisited = analyzedStops.find(s => s.isBehind) || null;
    const upcoming = analyzedStops.find(s => !s.isBehind) || null;

    return {
      route: isDowntown ? 'Downtown' : 'Uptown',
      absoluteClosest,
      lastVisited,
      upcoming,
      rawAnalysis: analyzedStops 
    };
  }

  /**
   * Fetches the closest active buses to a given coordinate via Proxy.
   * @param {number} lat - Latitude of the stop
   * @param {number} lng - Longitude of the stop
   * @param {number} limit - Number of closest buses to return (default: 3)
   */
  static async findBusesNearStop(lat, lng, limit = 3) {
    try {
      const res = await this.proxyRequest('/api/samsara/fleet', { filterText: '' });
      if (!res.success || !res.vehicles) {
        throw new Error('Failed to load fleet locations');
      }
      
      const activeLocations = res.vehicles;
      let busesWithDistance = [];
      activeLocations.forEach(v => {
        if (!v.latitude || !v.longitude) return;
        const distance = this.getDistanceMeters(lat, lng, v.latitude, v.longitude);
        
        busesWithDistance.push({
          id: v.id || v.name,
          name: v.name || 'Unknown Bus',
          latitude: v.latitude,
          longitude: v.longitude,
          heading: v.heading || 0,
          speed: v.speed || 0,
          time: v.time || new Date().toISOString(),
          address: v.address || 'Unknown Location',
          distanceToStop: distance
        });
      });

      busesWithDistance.sort((a, b) => a.distanceToStop - b.distanceToStop);
      return busesWithDistance.slice(0, limit);
    } catch (e) {
      console.error('[SamsaraEngine] findBusesNearStop failed:', e);
      throw e;
    }
  }

}

// ==========================================
// TEST MOCK DATA - Usage Example
// ==========================================
/*
(async () => {
    try {
        // Assume you have this list matching your Topview Logger stops
        const myStops = [
            { name: "Times Square", lat: 40.7580, lng: -73.9855 },
            { name: "Penn Station", lat: 40.7506, lng: -73.9935 },
            { name: "Central Park Zoo", lat: 40.7670, lng: -73.9740 }
        ];

        // 1. Fetch live telemetry for Bus ID 4205
        // const liveBus = await SamsaraEngine.fetchBusLocation('4205'); 

        // Simulated Response: Bus heading South down 7th Ave from Central Park
        const mockedLiveBus = {
            latitude: 40.7630, 
            longitude: -73.9780,
            heading: 210, // Driving roughly South-West
            speed: 15
        };

        // 2. Run the math engine
        const context = SamsaraEngine.resolveRouteContext(mockedLiveBus, myStops);

        console.log(`CURRENT TARGET: The bus is driving towards ${context.upcoming.name} (Distance: ${Math.round(context.upcoming.distanceMeters)}m)`);
        console.log(`PREVIOUS STOP: It already passed ${context.lastVisited.name} (Distance: ${Math.round(context.lastVisited.distanceMeters)}m behind)`);

    } catch(err) {
        console.error(err);
    }
})();
*/
if (typeof window !== 'undefined') {
  window.SamsaraEngine = SamsaraEngine;
}
export default SamsaraEngine;
