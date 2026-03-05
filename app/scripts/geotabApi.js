/**
 * GeotabApiService
 *
 * Scalable patterns:
 *  - ExceptionEvents: stream pages (10k/page) + aggregate on the fly (flat memory)
 *  - Utilization: 2 odometer StatusData reads per device (start/end), chunked multiCalls
 *
 * Notes:
 *  - This assumes rule IDs provided are correct for this DB.
 *  - Diagnostic ID for odometer MUST be a real diagnostic id in your DB.
 *    If "DiagnosticOdometerId" is a placeholder in your environment, replace it.
 */
window.GeotabApiService = function (api) {
  this.api = api;

  // Tune these if needed
  this.EXCEPTION_PAGE_SIZE = 10000;   // 5k–10k recommended for browser stability
  this.MULTICALL_CHUNK_SIZE = 500;    // safe default for Geotab databases
  this.ODO_DIAGNOSTIC_ID = "DiagnosticOdometerId"; // replace if needed with real diag id
};

window.GeotabApiService.prototype = {

  /** Single API call */
  _call: function (method, params) {
    return new Promise((resolve, reject) => {
      this.api.call(method, params, resolve, reject);
    });
  },

  /** Multi-call (array of [method, params]) */
  _multiCall: function (calls) {
    return new Promise((resolve, reject) => {
      this.api.multiCall(calls, resolve, reject);
    });
  },

  /**
   * Run multiCalls sequentially in chunks to avoid concurrent request limits.
   */
  _runChunkedMultiCall: async function (calls, chunkSize) {
    const size = chunkSize || this.MULTICALL_CHUNK_SIZE;
    let allResults = new Array(calls.length);
    let outIndex = 0;

    for (let i = 0; i < calls.length; i += size) {
      const chunk = calls.slice(i, i + size);
      const res = await this._multiCall(chunk);

      // res is an array aligned to chunk
      for (let j = 0; j < res.length; j++) {
        allResults[outIndex++] = res[j];
      }

      // Yield to keep UI responsive
      await new Promise(r => setTimeout(r, 0));
    }

    return allResults;
  },

  /**
   * Auto bucket size based on date range.
   */
  _getAutoBucketSize: function (fromDate, toDate) {
    const days = (toDate - fromDate) / (1000 * 60 * 60 * 24);
    if (days <= 14) return "daily";
    if (days <= 90) return "weekly";
    return "monthly";
  },

  /**
   * Bucket key.
   */
  _getBucketKey: function (date, bucketSize) {
    const d = new Date(date);

    if (bucketSize === "daily") {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    if (bucketSize === "weekly") {
      // Week start Sunday
      const weekStart = new Date(d);
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(d.getDate() - d.getDay());
      return "W/" + weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  },

  /**
   * Build ordered bucket labels between fromDate and toDate.
   */
  _buildBucketLabels: function (fromDate, toDate, bucketSize) {
    const labels = [];
    const seen = new Set();
    const curr = new Date(fromDate);

    // Normalize
    curr.setHours(0, 0, 0, 0);

    while (curr <= toDate) {
      const key = this._getBucketKey(curr, bucketSize);
      if (!seen.has(key)) {
        labels.push(key);
        seen.add(key);
      }

      if (bucketSize === "daily") curr.setDate(curr.getDate() + 1);
      else if (bucketSize === "weekly") curr.setDate(curr.getDate() + 7);
      else curr.setMonth(curr.getMonth() + 1);
    }

    return labels;
  },

  /**
   * Stream ExceptionEvents in pages and aggregate with onPage callback.
   *
   * IMPORTANT:
   *  - We specify sort so that advancing fromDate is safe.
   *  - We do not accumulate all events (flat memory).
   */
  _streamExceptionEventsAgg: async function (ruleId, fromDate, toDate, onPage) {
    const PAGE_SIZE = this.EXCEPTION_PAGE_SIZE;
    let currentFromDate = new Date(fromDate);

    // Safety: prevent accidental infinite loops
    let guard = 0;

    while (currentFromDate < toDate) {
      guard++;
      if (guard > 20000) {
        console.warn("Guard stop: too many ExceptionEvent pages. Check sort/advance logic.");
        break;
      }

      let results = [];
      try {
        results = await this._call("Get", {
          typeName: "ExceptionEvent",
          search: {
            fromDate: currentFromDate.toISOString(),
            toDate: toDate.toISOString(),
            ruleSearch: { id: ruleId }
          },
          // Sorting is critical for safe paging
          sort: { sortBy: "activeFrom", sortDirection: "asc" },
          resultsLimit: PAGE_SIZE
        });
      } catch (err) {
        console.warn(`ExceptionEvent fetch failed for rule ${ruleId}:`, err);
        break;
      }

      if (!results || results.length === 0) break;

      // Aggregate this page
      try {
        onPage(results);
      } catch (e) {
        console.error("onPage aggregation failed:", e);
        throw e;
      }

      if (results.length < PAGE_SIZE) break;

      // Advance to just after the last record in sorted results
      const last = results[results.length - 1];
      const lastTime = new Date(last.activeFrom || last.activeTo);
      const nextFrom = new Date(lastTime.getTime() + 1);

      // If sort/advance didn't progress, break to avoid infinite loop
      if (nextFrom <= currentFromDate) {
        console.warn("Paging did not advance; breaking to avoid infinite loop.");
        break;
      }

      currentFromDate = nextFrom;

      // Yield to avoid locking the UI thread
      await new Promise(r => setTimeout(r, 0));
    }
  },

  /**
   * Get active devices. NOTE:
   * Some DBs use activeTo null for active devices; others set a far-future date.
   * This implementation treats null/undefined activeTo as active.
   */
  getDevices: async function () {
    const devices = await this._call("Get", { typeName: "Device" });
    const now = new Date();

    return (devices || []).filter(d => {
      if (!d) return false;
      if (!d.activeTo) return true; // treat no activeTo as active
      return new Date(d.activeTo) > now;
    });
  },

  /**
   * Get group mapping and raw groups.
   */
  getDeviceGroupsMap: async function () {
    try {
      const results = await this._multiCall([
        ["Get", { typeName: "Device" }],
        ["Get", { typeName: "Group" }]
      ]);

      const devices = results[0] || [];
      const groups = results[1] || [];

      const groupNameMap = {};
      groups.forEach(g => { groupNameMap[g.id] = g.name; });

      const deviceGroupMap = {};
      devices.forEach(d => {
        const names = [];
        const idKey = d.id + "_ids";
        deviceGroupMap[idKey] = [];

        (d.groups || []).forEach(g => {
          if (groupNameMap[g.id]) names.push(groupNameMap[g.id]);
          deviceGroupMap[idKey].push(g.id);
        });

        deviceGroupMap[d.id] = names.join(", ");
      });

      return { map: deviceGroupMap, rawGroups: groups };
    } catch (e) {
      console.error("Error fetching groups", e);
      return { map: {}, rawGroups: [] };
    }
  },

  /**
   * Idle duration per device + trend data.
   * Replace the rule id below with your real idling rule id.
   */
  getIdleDurationPerDevice: async function (devices, fromDate, toDate) {
    const bucketSize = this._getAutoBucketSize(fromDate, toDate);
    const bucketLabels = this._buildBucketLabels(fromDate, toDate, bucketSize);
    const bucketHours = Object.fromEntries(bucketLabels.map(l => [l, 0]));

    // TODO: replace with your actual idling rule id
    const IDLING_RULE_ID = "aU_66pnHj8EeIWFcP8CcX7Q";

    const deviceIdling = {};
    let totalHours = 0;

    await this._streamExceptionEventsAgg(IDLING_RULE_ID, fromDate, toDate, (events) => {
      for (const event of events) {
        const devId = event.device && event.device.id;
        if (!devId) continue;

        const start = new Date(event.activeFrom);
        const end = new Date(event.activeTo || event.activeFrom);
        const hours = (end - start) / 3600000;

        deviceIdling[devId] = (deviceIdling[devId] || 0) + hours;
        totalHours += hours;

        const key = this._getBucketKey(start, bucketSize);
        if (bucketHours[key] !== undefined) bucketHours[key] += hours;
      }
    });

    const trendData = bucketLabels.map(l => ({ label: l, value: bucketHours[l] || 0 }));
    return { totalHours, deviceIdling, trendData, bucketSize };
  },

  /**
   * Harsh driving per device + trend data (bucketed).
   * Uses your provided harsh IDs.
   */
  getHarshDrivingPerDevice: async function (devices, fromDate, toDate) {
    const bucketSize = this._getAutoBucketSize(fromDate, toDate);
    const bucketLabels = this._buildBucketLabels(fromDate, toDate, bucketSize);
    const bucketCounts = Object.fromEntries(bucketLabels.map(l => [l, 0]));

    const deviceHarshCounts = {};
    let totalCount = 0;

    const ruleIds = [
      "RuleJackrabbitStartsId",
      "RuleHarshBrakingId",
      "RuleHarshCorneringId"
    ];

    for (const ruleId of ruleIds) {
      await this._streamExceptionEventsAgg(ruleId, fromDate, toDate, (events) => {
        for (const event of events) {
          const devId = event.device && event.device.id;
          if (!devId) continue;

          deviceHarshCounts[devId] = (deviceHarshCounts[devId] || 0) + 1;
          totalCount++;

          const key = this._getBucketKey(event.activeFrom, bucketSize);
          if (bucketCounts[key] !== undefined) bucketCounts[key] += 1;
        }
      });
    }

    const trendData = bucketLabels.map(l => ({ label: l, value: bucketCounts[l] || 0 }));
    return { totalCount, deviceHarshCounts, trendData, bucketSize };
  },

  /**
   * Utilization per device using odometer delta in the date range.
   *
   * Correct approach:
   *  - Start odo: earliest StatusData in [fromDate,toDate] (sort asc, limit 1)
   *  - End odo: latest StatusData in [fromDate,toDate] (sort desc, limit 1)
   *
   * This is much lighter than Trip for large ranges.
   */
  getUtilizationPerDevice: async function (devices, fromDate, toDate) {
    const ODO_ID = this.ODO_DIAGNOSTIC_ID;

    try {
      const startCalls = devices.map(d => ["Get", {
        typeName: "StatusData",
        search: {
          deviceSearch: { id: d.id },
          diagnosticSearch: { id: ODO_ID },
          fromDate: fromDate.toISOString(),
          toDate: toDate.toISOString()
        },
        sort: { sortBy: "dateTime", sortDirection: "asc" },
        resultsLimit: 1
      }]);

      const endCalls = devices.map(d => ["Get", {
        typeName: "StatusData",
        search: {
          deviceSearch: { id: d.id },
          diagnosticSearch: { id: ODO_ID },
          fromDate: fromDate.toISOString(),
          toDate: toDate.toISOString()
        },
        sort: { sortBy: "dateTime", sortDirection: "desc" },
        resultsLimit: 1
      }]);

      // Chunk both sets to keep requests manageable
      const startResults = await this._runChunkedMultiCall(startCalls, this.MULTICALL_CHUNK_SIZE);
      const endResults = await this._runChunkedMultiCall(endCalls, this.MULTICALL_CHUNK_SIZE);

      const deviceUtilization = {};
      let underutilizedCount = 0;

      // Threshold: < 2 km (~1.24 mi) movement in the period counts as underutilized
      // Adjust threshold as needed.
      const MIN_DISTANCE = 2.0; // in same units as your odometer diagnostic

      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];

        const startArr = startResults[i];
        const endArr = endResults[i];

        const startOdo = (startArr && startArr.length) ? startArr[0].data : null;
        const endOdo = (endArr && endArr.length) ? endArr[0].data : null;

        let isUnderutilized = true;

        if (startOdo !== null && endOdo !== null) {
          const delta = Math.abs(endOdo - startOdo);
          isUnderutilized = delta < MIN_DISTANCE;
        } else {
          // If no odometer data within range, treat as underutilized/offline
          isUnderutilized = true;
        }

        deviceUtilization[d.id] = isUnderutilized;
        if (isUnderutilized) underutilizedCount++;
      }

      return { underutilizedCount, deviceUtilization };
    } catch (e) {
      console.error("Error fetching utilization data", e);
      throw e;
    }
  }
};
