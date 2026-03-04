/**
 * Service to handle data fetching from Geotab API
 */
window.GeotabApiService = function (api) {
    this.api = api;
};

window.GeotabApiService.prototype = {
    /**
     * Helper to perform API multi-calls
     */
    _multiCall: function (calls) {
        return new Promise((resolve, reject) => {
            this.api.multiCall(calls, function (results) {
                resolve(results);
            }, function (err) {
                reject(err);
            });
        });
    },

    /**
     * Helper to perform single API call
     */
    _call: function (method, params) {
        return new Promise((resolve, reject) => {
            this.api.call(method, params, function (result) {
                resolve(result);
            }, function (err) {
                reject(err);
            });
        });
    },

    /**
     * Get active devices without massive historical lookback to save memory
     */
    getDevices: async function () {
        try {
            return await this._call("Get", {
                typeName: "Device"
            });
        } catch (e) {
            console.error("Error fetching devices", e);
            throw e;
        }
    },

    /**
     * Get Device Groups map
     */
    getDeviceGroupsMap: async function () {
        try {
            const calls = [
                ["Get", { typeName: "Device" }],
                ["Get", { typeName: "Group" }]
            ];

            const results = await this._multiCall(calls);
            const devices = results[0] || [];
            const groups = results[1] || [];

            const groupMap = {};
            groups.forEach(g => { groupMap[g.id] = g.name; });

            const deviceGroupMap = {};
            devices.forEach(d => {
                const deviceGroups = [];
                if (d.groups) {
                    d.groups.forEach(g => {
                        if (groupMap[g.id]) deviceGroups.push(groupMap[g.id]);
                    });
                }
                deviceGroupMap[d.id] = deviceGroups.join(", ");
            });
            return deviceGroupMap;
        } catch (e) {
            console.error("Error fetching groups", e);
            return {};
        }
    },

    /**
     * Get Idle duration structured per device
     */
    getIdleDurationPerDevice: async function (fromDate, toDate) {
        try {
            const results = await this._call("Get", {
                typeName: "ExceptionEvent",
                search: {
                    fromDate: fromDate.toISOString(),
                    toDate: toDate.toISOString(),
                    ruleSearch: { id: "RuleIdlingId" }
                }
            });

            const deviceIdling = {}; // { deviceId: hours }
            let totalHours = 0;

            if (results) {
                results.forEach(event => {
                    if (!event.device || !event.device.id) return;
                    const devId = event.device.id;
                    const start = new Date(event.activeFrom);
                    const end = new Date(event.activeTo);
                    const hours = (end.getTime() - start.getTime()) / 3600000;

                    if (!deviceIdling[devId]) deviceIdling[devId] = 0;
                    deviceIdling[devId] += hours;
                    totalHours += hours;
                });
            }

            return { totalHours, deviceIdling };
        } catch (e) {
            console.error("Error fetching idle data", e);
            throw e;
        }
    },

    /**
     * Get Harsh Driving event counts per device
     */
    getHarshDrivingPerDevice: async function (fromDate, toDate) {
        const calls = [
            ["Get", { typeName: "ExceptionEvent", search: { fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), ruleSearch: { id: "RuleHardAccelerationId" } } }],
            ["Get", { typeName: "ExceptionEvent", search: { fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), ruleSearch: { id: "RuleHardBrakingId" } } }],
            ["Get", { typeName: "ExceptionEvent", search: { fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), ruleSearch: { id: "RuleHardCorneringId" } } }]
        ];

        try {
            const results = await this._multiCall(calls);
            const deviceHarshCounts = {}; // { deviceId: count }
            let totalCount = 0;

            results.forEach(ruleEvents => {
                if (ruleEvents) {
                    ruleEvents.forEach(event => {
                        if (!event.device || !event.device.id) return;
                        const devId = event.device.id;
                        if (!deviceHarshCounts[devId]) deviceHarshCounts[devId] = 0;
                        deviceHarshCounts[devId]++;
                        totalCount++;
                    });
                }
            });

            return { totalCount, deviceHarshCounts };
        } catch (e) {
            console.error("Error fetching harsh driving data", e);
            throw e;
        }
    },

    /**
     * Get underutilized vehicles mapping
     * Optimized: Just look for StatusData instead of gigantic Trip lists
     */
    getUtilizationPerDevice: async function (devices, fromDate, toDate) {
        try {
            // Because trips can be massive for an entire fleet, 
            // a faster approach is looking for ANY LogRecord or StatusData.
            // But if we must use Trips, we limit the payload to bare minimum
            const trips = await this._call("Get", {
                typeName: "Trip",
                search: {
                    fromDate: fromDate.toISOString(),
                    toDate: toDate.toISOString()
                }
            });

            const devicesWithTrips = new Set();
            if (trips) {
                trips.forEach(trip => {
                    if (trip.device && trip.device.id) {
                        devicesWithTrips.add(trip.device.id);
                    }
                });
            }

            const deviceUtilization = {}; // { deviceId: isUnderutilized (boolean) }
            let underutilizedCount = 0;

            devices.forEach(d => {
                const isUnderutilized = !devicesWithTrips.has(d.id);
                deviceUtilization[d.id] = isUnderutilized;
                if (isUnderutilized) underutilizedCount++;
            });

            return { underutilizedCount, deviceUtilization };
        } catch (e) {
            console.error("Error fetching utilization data", e);
            throw e;
        }
    }
};
