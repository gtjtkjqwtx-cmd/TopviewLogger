class DispatchEngine {
  /**
   * Normalizes bus identifiers (e.g. "501 - TAT" -> "501", "0367" -> "367")
   */
  static normalizeBusId(id) {
    if (!id) return '';
    const match = id.toString().match(/\d+/);
    if (match) {
      return match[0].replace(/^0+/, '') || '0';
    }
    return id.toString().toLowerCase()
      .replace(/bus/gi, '')
      .replace(/[^a-z0-9]/gi, '')
      .trim();
  }

  /**
   * Formats a raw stop string (e.g. "STOP 4 - 42nd St & 8th Ave") to clean "Stop 4"
   */
  static formatStopLabel(stopStr) {
    if (!stopStr) return 'Stop -';
    const match = stopStr.match(/STOP\s*#?\s*(\d+)/i);
    if (match) {
      return `Stop ${match[1]}`;
    }
    return stopStr.trim();
  }

  /**
   * Categorizes route into Downtown, Uptown, Night Tour, or Default (No emojis)
   */
  static getRouteMeta(routeStr) {
    if (!routeStr) return { name: 'Route', class: 'badge-route-default' };
    const r = routeStr.toLowerCase();
    if (r.includes('down') || r.includes('dt')) {
      return { name: 'Downtown', class: 'badge-route-downtown' };
    }
    if (r.includes('up') || r.includes('uptown')) {
      return { name: 'Uptown', class: 'badge-route-uptown' };
    }
    if (r.includes('night') || r.includes('evening') || r.includes('tour')) {
      return { name: 'Night Tour', class: 'badge-route-night' };
    }
    return { name: routeStr, class: 'badge-route-default' };
  }

  /**
   * Cleans concatenated role titles from supervisor names (e.g. "Elijoel ParkerFieldCoordinator" -> "Elijoel Parker")
   */
  static cleanSupervisorName(userName) {
    if (!userName) return '';
    let clean = userName
      .replace(/FieldCoordinator/gi, '')
      .replace(/Supervisor/gi, '')
      .replace(/Coordinator/gi, '')
      .replace(/Admin/gi, '')
      .trim();
    return clean || userName;
  }

  /**
   * Determines the Supervisor from a record
   * When (User) !== (Operator), User is the supervisor (ignoring Stevenson and Michael Leshaj).
   */
  static extractSupervisor(record) {
    if (!record || !record.user) return null;
    const u = record.user.trim();
    const op = (record.operator || '').trim();
    const lower = u.toLowerCase();

    // Ignore known admin blacklist
    if (lower.includes('stevenson') || lower.includes('michael leshaj') || lower === 'michael') {
      return null;
    }

    if (u && (!op || u.toLowerCase() !== op.toLowerCase())) {
      return this.cleanSupervisorName(u);
    }
    return null;
  }

  /**
   * Finds the most recent operator for a specific bus from CountIf records.
   * Priority: Most recent Stop 1 entry with the Operator name (today's calendar day).
   */
  static findActiveDriver(busId, dispatchRecords) {
    if (!busId || !dispatchRecords || dispatchRecords.length === 0) {
      return null;
    }

    const targetId = this.normalizeBusId(busId);
    const todayStr = new Date().toDateString();

    // Filter today's records for this bus
    const matches = dispatchRecords.filter(r => {
      if (!r.bus || !r.date) return false;
      const rDate = new Date(r.date);
      const isToday = rDate.toDateString() === todayStr;
      return this.normalizeBusId(r.bus) === targetId && isToday;
    });

    if (matches.length === 0) {
      return null;
    }

    // Sort by date descending (newest first)
    matches.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 1. Priority: Find most recent Stop 1 entry with valid operator
    const stop1Match = matches.find(r => {
      const isStop1 = r.stop && (r.stop.toUpperCase().includes('STOP 1 ') || r.stop.toUpperCase().includes('STOP #1') || r.stop.toUpperCase().startsWith('STOP 1'));
      return isStop1 && r.operator && r.operator.trim() !== '';
    });

    if (stop1Match) {
      return stop1Match;
    }

    // 2. Fallback: Most recent entry with valid operator
    const anyOperatorMatch = matches.find(r => r.operator && r.operator.trim() !== '');
    return anyOperatorMatch || matches[0];
  }

  /**
   * Finds the latest supervisor at a specific stop for today
   */
  static findSupervisorForStop(stopNum, dispatchRecords) {
    if (!stopNum || !dispatchRecords || dispatchRecords.length === 0) return null;
    const cleanStop = stopNum.toString().trim();
    const target = `STOP ${cleanStop} `;
    const todayStr = new Date().toDateString();

    const matches = dispatchRecords.filter(r => {
      if (!r.stop || !r.date) return false;
      const isToday = new Date(r.date).toDateString() === todayStr;
      const s = r.stop.toUpperCase();
      return isToday && (s.includes(target) || s.includes(`STOP #${cleanStop}`) || s.includes(`STOP ${cleanStop}`));
    });

    matches.sort((a, b) => new Date(b.date) - new Date(a.date));

    for (const rec of matches) {
      const sup = this.extractSupervisor(rec);
      if (sup) return sup;
    }
    return null;
  }

  /**
   * Enriches Samsara telemetry with Dispatch info.
   */
  static getEnrichedStatus(busGps, busId, dispatchRecords) {
    const driverInfo = this.findActiveDriver(busId, dispatchRecords);
    
    return {
      ...busGps,
      busId: busId,
      operator: driverInfo ? driverInfo.operator : 'Unknown Driver',
      lastDispatchStop: driverInfo ? this.formatStopLabel(driverInfo.stop) : 'N/A',
      dispatchTime: driverInfo ? driverInfo.date : null
    };
  }
}

export default DispatchEngine;
