/**
 * Main Controller for ROI Calculator Add-in
 */
geotab.addin.roiCalculator = function (api, state) {
    'use strict';

    // Services
    let apiService;

    // DOM Elements
    const elements = {
        dateFromInput: document.getElementById('date-from'),
        dateToInput: document.getElementById('date-to'),
        groupFilterInput: document.getElementById('group-filter'),
        fuelPriceInput: document.getElementById('fuel-price'),
        harshCostInput: document.getElementById('harsh-cost'),
        stationaryCostInput: document.getElementById('stationary-cost'),
        calculateBtn: document.getElementById('calculate-btn'),
        loadingOverlay: document.getElementById('loading-overlay'),

        // Output cards
        metricIdle: document.getElementById('metric-idle-cost'),
        detailIdle: document.getElementById('detail-idle'),
        metricSafety: document.getElementById('metric-safety-risk'),
        detailSafety: document.getElementById('detail-safety'),
        metricUtil: document.getElementById('metric-utilization'),
        detailUtil: document.getElementById('detail-util'),
        metricTotal: document.getElementById('metric-total-savings'),

        // Leaderboards
        leaderboardWorstBody: document.getElementById('leaderboard-worst-body'),
        leaderboardBestBody: document.getElementById('leaderboard-best-body'),

        // Chart
        savingsChartCanvas: document.getElementById('savingsChart'),
        trendChartCanvas: document.getElementById('trendChart')
    };

    // Core Constants for calculations (Assumptions)
    const IDLE_FUEL_BURN_RATE_GPH = 0.5; // Average gallons per hour consumed while idling

    // Add-in state
    let cachedData = {
        selectedDaysCount: 30,
        devices: [],
        deviceGroupsMap: {},
        rawGroups: [],
        idleHoursData: { totalHours: 0, deviceIdling: {}, trendData: [], bucketSize: 'monthly' },
        harshEventsData: { totalCount: 0, deviceHarshCounts: {}, trendData: [], bucketSize: 'monthly' },
        utilizationData: { underutilizedCount: 0, deviceUtilization: {} },
        tableRows: []
    };

    // Chart Instances
    let savingsChartInstance = null;
    let trendChartInstance = null;

    /**
     * Set default dates in UI (Last 30 days)
     */
    const setDefaultDates = () => {
        const today = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(today.getDate() - 30);

        if (elements.dateToInput) elements.dateToInput.valueAsDate = today;
        if (elements.dateFromInput) elements.dateFromInput.valueAsDate = thirtyDaysAgo;
    };

    /**
     * Calculate days between two Dates
     */
    const calculateDaysBetween = (from, to) => {
        const diffTime = Math.abs(to - from);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays > 0 ? diffDays : 1;
    };

    /**
     * Formats a number as currency ($X.XX)
     */
    const formatCurrency = (val) => {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
    };

    /**
     * Formats a number with commas
     */
    const formatNumber = (val) => {
        return new Intl.NumberFormat('en-US').format(Math.round(val));
    };

    /**
     * Renders or updates Chart.js instance with new totals
     */
    const renderChart = (idleCost, safetyCost, utilCost) => {
        const ctx = elements.savingsChartCanvas.getContext('2d');

        const data = {
            labels: ['Total Potential Savings'],
            datasets: [
                {
                    label: 'Excess Idling Cost',
                    data: [idleCost],
                    backgroundColor: 'rgba(37, 83, 153, 0.8)', // Geotab Blue
                    borderWidth: 0
                },
                {
                    label: 'Harsh Driving Cost',
                    data: [safetyCost],
                    backgroundColor: 'rgba(250, 162, 27, 0.8)', // Orange
                    borderWidth: 0
                },
                {
                    label: 'Stationary Asset Cost',
                    data: [utilCost],
                    backgroundColor: 'rgba(239, 68, 68, 0.8)', // Red
                    borderWidth: 0
                }
            ]
        };

        const config = {
            type: 'bar',
            data: data,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += formatCurrency(context.parsed.y);
                                }
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        stacked: true,
                    },
                    y: {
                        stacked: true,
                        ticks: {
                            callback: function (value) {
                                return '$' + value;
                            }
                        }
                    }
                }
            }
        };

        if (savingsChartInstance) {
            savingsChartInstance.destroy();
        }

        savingsChartInstance = new window.Chart(ctx, config);
    };

    /**
     * Renders the Trend Line Chart (Cost over Time) using bucketed data from API.
     * BucketSize is auto-detected from the date range: daily/weekly/monthly.
     */
    const renderTrendChart = () => {
        if (!elements.trendChartCanvas) return;
        const ctx = elements.trendChartCanvas.getContext('2d');

        const fuelPrice = parseFloat(elements.fuelPriceInput.value) || 0;
        const harshEventCost = parseFloat(elements.harshCostInput.value) || 0;
        const stationaryDailyCost = parseFloat(elements.stationaryCostInput.value) || 0;

        const bucketSize = cachedData.idleHoursData.bucketSize || 'monthly';
        const days = cachedData.selectedDaysCount || 30;

        const idleTrend = cachedData.idleHoursData.trendData || [];
        const harshTrend = cachedData.harshEventsData.trendData || [];

        if (idleTrend.length === 0) return; // No data yet

        const labels = idleTrend.map(d => d.label);

        const idleDataset = idleTrend.map(d => parseFloat((d.value * IDLE_FUEL_BURN_RATE_GPH * fuelPrice).toFixed(2)));
        const harshDataset = harshTrend.map(d => parseFloat((d.value * harshEventCost).toFixed(2)));
        const totalDataset = labels.map((_, i) => parseFloat(((idleDataset[i] || 0) + (harshDataset[i] || 0)).toFixed(2)));

        // Bucket granularity label
        const granularityLabel = bucketSize.charAt(0).toUpperCase() + bucketSize.slice(1);

        const trendConfig = {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Total Fleet Cost',
                        data: totalDataset,
                        borderColor: 'rgba(37, 83, 153, 1)',
                        backgroundColor: 'rgba(37, 83, 153, 0.1)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.3,
                        pointRadius: labels.length > 60 ? 0 : 4
                    },
                    {
                        label: 'Idle Cost',
                        data: idleDataset,
                        borderColor: 'rgba(37, 83, 153, 0.5)',
                        borderWidth: 1.5,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0
                    },
                    {
                        label: 'Harsh Driving Cost',
                        data: harshDataset,
                        borderColor: 'rgba(250, 162, 27, 0.8)',
                        borderWidth: 1.5,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                return `${context.dataset.label}: ${formatCurrency(context.parsed.y)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { maxTicksLimit: 12, maxRotation: 45, minRotation: 30 } },
                    y: {
                        ticks: { callback: value => '$' + value.toLocaleString() }
                    }
                }
            }
        };

        if (trendChartInstance) {
            trendChartInstance.destroy();
        }
        trendChartInstance = new window.Chart(ctx, trendConfig);

        // Update chart title with auto-detected granularity
        const titleEl = document.getElementById('trend-chart-title');
        if (titleEl) titleEl.textContent = `Cost Trend — ${granularityLabel} View`;
    };

    /**
     * Renders the calculated mathematical results back to the UI
     */
    const updateCalculationsUI = () => {
        // Inputs
        const fuelPrice = parseFloat(elements.fuelPriceInput.value) || 0;
        const stationaryDailyCost = parseFloat(elements.stationaryCostInput.value) || 0;
        const harshEventCost = parseFloat(elements.harshCostInput.value) || 0;
        const days = cachedData.selectedDaysCount || 30;
        const selectedGroupId = elements.groupFilterInput.value;

        // Filter Devices Globally based on group
        let filteredDevices = cachedData.devices;
        if (selectedGroupId && selectedGroupId !== 'all') {
            filteredDevices = cachedData.devices.filter(d => {
                const deviceGroupIds = cachedData.deviceGroupsMap[d.id + '_ids'] || [];
                return deviceGroupIds.includes(selectedGroupId);
            });
        }

        // Recalculate Totals based on filtered devices
        let totalIdleHours = 0;
        let totalHarshCount = 0;
        let totalUnderutilizedCount = 0;

        filteredDevices.forEach(d => {
            totalIdleHours += cachedData.idleHoursData.deviceIdling[d.id] || 0;
            totalHarshCount += cachedData.harshEventsData.deviceHarshCounts[d.id] || 0;
            if (cachedData.utilizationData.deviceUtilization[d.id]) totalUnderutilizedCount++;
        });

        // 1. Top Level Metrics
        const totalIdleCost = totalIdleHours * IDLE_FUEL_BURN_RATE_GPH * fuelPrice;
        const totalSafetyCost = totalHarshCount * harshEventCost;
        const utilCostTotal = totalUnderutilizedCount * stationaryDailyCost * days;

        const totalSavings = totalIdleCost + totalSafetyCost + utilCostTotal; // Now includes Safety Config Cost

        // Update Top Cards
        elements.metricIdle.textContent = formatCurrency(totalIdleCost);
        elements.detailIdle.textContent = `${formatNumber(totalIdleHours)} hours of excess idling`;

        elements.metricSafety.textContent = formatCurrency(totalSafetyCost);
        elements.detailSafety.textContent = `${formatNumber(totalHarshCount)} events across fleet`;

        elements.metricUtil.textContent = formatCurrency(utilCostTotal);
        elements.detailUtil.textContent = `${formatNumber(totalUnderutilizedCount)} vehicles underutilized`;

        elements.metricTotal.textContent = formatCurrency(totalSavings);

        // Update detail text to reflect dynamic dates
        const totalCardDetail = document.querySelector('.total-card .detail');
        if (totalCardDetail) {
            totalCardDetail.textContent = `Over the selected ${days} days`;
        }

        // Render Visual Breakdown (Bar)
        renderChart(totalIdleCost, totalSafetyCost, utilCostTotal);

        // Render Trend Line Chart
        renderTrendChart();

        // 2. Build Table & Leaderboard Data
        const tbody = document.getElementById('asset-table-body');
        tbody.innerHTML = ''; // Clear
        cachedData.tableRows = [];

        if (!filteredDevices || filteredDevices.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No devices found for selected criteria.</td></tr>`;
            elements.leaderboardWorstBody.innerHTML = `<tr><td colspan="2" class="empty-state">No data</td></tr>`;
            elements.leaderboardBestBody.innerHTML = `<tr><td colspan="2" class="empty-state">No data</td></tr>`;
            return;
        }

        const deviceCosts = [];

        filteredDevices.forEach(device => {
            const devId = device.id;

            // Device specific math
            const devIdleHours = cachedData.idleHoursData.deviceIdling[devId] || 0;
            const devIdleCost = devIdleHours * IDLE_FUEL_BURN_RATE_GPH * fuelPrice;

            const devHarshCount = cachedData.harshEventsData.deviceHarshCounts[devId] || 0;
            const devSafetyCost = devHarshCount * harshEventCost;

            const devStationaryPeriods = cachedData.utilizationData.deviceUtilizationSubperiods[devId] || 0;
            const devUtilCost = devStationaryPeriods * daysPerSubPeriod * stationaryDailyCost;

            const devTotalPotentialSavings = devIdleCost + devSafetyCost + devUtilCost;

            deviceCosts.push({
                device,
                devIdleCost,
                devHarshCount,
                devSafetyCost,
                devUtilCost,
                devTotalPotentialSavings
            });
        });

        // Render Tables
        // ------------------

        // Asset Table (Alphabetical)
        const sortedAlphabetical = [...deviceCosts].sort((a, b) => a.device.name.localeCompare(b.device.name));

        sortedAlphabetical.forEach(data => {
            if (data.devTotalPotentialSavings > 0 || data.devHarshCount > 0) {
                const tr = document.createElement('tr');
                const groupsStr = cachedData.deviceGroupsMap[data.device.id] || 'No Group';

                tr.innerHTML = `
                    <td>${data.device.name}</td>
                    <td>${groupsStr}</td>
                    <td>${formatCurrency(data.devIdleCost)}</td>
                    <td>${formatNumber(data.devHarshCount)}</td>
                    <td class="util-col">${formatCurrency(data.devUtilCost)}</td>
                    <td><strong>${formatCurrency(data.devTotalPotentialSavings)}</strong></td>
                `;
                tbody.appendChild(tr);

                // Save for export format (raw numbers for CSV)
                cachedData.tableRows.push({
                    Vehicle: data.device.name,
                    Groups: `"${groupsStr}"`,
                    IdleCost: data.devIdleCost.toFixed(2),
                    SafetyRiskCount: data.devHarshCount,
                    UtilizationCost: data.devUtilCost.toFixed(2),
                    TotalSavings: data.devTotalPotentialSavings.toFixed(2)
                });
            }
        });

        if (cachedData.tableRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No actionable savings found for selected criteria.</td></tr>`;
        }

        // Leaderboards (Cost Value)
        const sortedByCost = [...deviceCosts].sort((a, b) => b.devTotalPotentialSavings - a.devTotalPotentialSavings);

        // Worst 5
        const worst5 = sortedByCost.slice(0, 5);
        elements.leaderboardWorstBody.innerHTML = worst5.map(d => `
            <tr>
                <td>${d.device.name}</td>
                <td style="text-align: right;"><strong>${formatCurrency(d.devTotalPotentialSavings)}</strong></td>
            </tr>
        `).join('');

        // Best 5
        const best5 = sortedByCost.filter(d => d.devTotalPotentialSavings > 0).reverse().slice(0, 5);
        if (best5.length === 0) {
            elements.leaderboardBestBody.innerHTML = `<tr><td colspan="2" class="empty-state">No devices with measured costs</td></tr>`;
        } else {
            elements.leaderboardBestBody.innerHTML = best5.map(d => `
                <tr>
                    <td>${d.device.name}</td>
                    <td style="text-align: right;"><strong>${formatCurrency(d.devTotalPotentialSavings)}</strong></td>
                </tr>
            `).join('');
        }
    };

    /**
     * Fetches raw data from Geotab API using the selected date range
     */
    const fetchData = async () => {
        let fromDate = elements.dateFromInput.valueAsDate;
        let toDate = elements.dateToInput.valueAsDate;

        // Fallback if inputs are invalid/empty
        if (!fromDate || !toDate) {
            toDate = new Date();
            fromDate = new Date();
            fromDate.setDate(toDate.getDate() - 30);

            elements.dateToInput.valueAsDate = toDate;
            elements.dateFromInput.valueAsDate = fromDate;
        }

        // Calculate days for UI math
        const days = calculateDaysBetween(fromDate, toDate);

        // Show loading state
        elements.loadingOverlay.classList.remove('hidden');

        try {
            console.log(`ROI Calculator: Fetching data for past ${days} days...`);

            // Fetch Devices & Groups sequentially to avoid MyGeotab API limits (concurrent large pulls drop connections)
            console.log("ROI Calculator: Fetching devices...");
            const devices = await apiService.getDevices();

            console.log("ROI Calculator: Fetching groups map...");
            const groupData = await apiService.getDeviceGroupsMap();

            console.log("ROI Calculator: Fetching idle duration...");
            const idleHoursData = await apiService.getIdleDurationPerDevice(devices, fromDate, toDate);

            console.log("ROI Calculator: Fetching harsh driving data...");
            const harshEventsData = await apiService.getHarshDrivingPerDevice(devices, fromDate, toDate);

            console.log("ROI Calculator: Fetching trip utilization...");
            const utilizationData = await apiService.getUtilizationPerDevice(devices, fromDate, toDate);

            // Cache data
            cachedData = {
                devices,
                deviceGroupsMap: groupData.map,
                rawGroups: groupData.rawGroups,
                idleHoursData,
                harshEventsData,
                utilizationData,
                tableRows: []
            };

            // Populate Dropdown Hierarchically if not already built
            if (elements.groupFilterInput.options.length <= 1) {
                elements.groupFilterInput.innerHTML = '<option value="all">All Groups</option>'; // reset

                const rawGroups = groupData.rawGroups;
                const groupMap = new Map();
                rawGroups.forEach(g => groupMap.set(g.id, g));

                // Find root groups
                const allChildrenIds = new Set();
                rawGroups.forEach(g => {
                    if (g.children) {
                        g.children.forEach(c => allChildrenIds.add(c.id));
                    }
                });

                const rootGroups = rawGroups.filter(g => !allChildrenIds.has(g.id)).sort((a, b) => a.name.localeCompare(b.name));

                const addGroupOpt = (group, depth) => {
                    const opt = document.createElement('option');
                    opt.value = group.id;
                    const isFolder = group.children && group.children.length > 0;
                    const indent = '\u00A0\u00A0\u00A0\u00A0'.repeat(depth);
                    opt.textContent = indent + (isFolder ? '📁 ' : '') + group.name;

                    elements.groupFilterInput.appendChild(opt);

                    if (isFolder) {
                        const sortedChildren = group.children
                            .map(c => groupMap.get(c.id))
                            .filter(c => c)
                            .sort((a, b) => a.name.localeCompare(b.name));

                        sortedChildren.forEach(c => addGroupOpt(c, depth + 1));
                    }
                };

                rootGroups.forEach(g => addGroupOpt(g, 0));
            }

            // Calculate and display
            updateCalculationsUI();
            console.log("ROI Calculator: Data load complete");

        } catch (error) {
            console.error("ROI Calculator: Error fetching API data", error);
            alert("Error fetching fleet data. Try selecting a shorter date range if your fleet is very large.");
        } finally {
            // Hide loading state
            elements.loadingOverlay.classList.add('hidden');
        }
    };

    /**
     * Generate and download CSV
     */
    const exportToCsv = () => {
        if (!cachedData.tableRows || cachedData.tableRows.length === 0) {
            alert("No data available to export.");
            return;
        }

        const headers = ["Vehicle", "Groups", "Idle Cost ($)", "Harsh Events", "Utilization Cost ($)", "Total Savings ($)"];
        let csvContent = headers.join(",") + "\n";

        cachedData.tableRows.forEach(row => {
            const rowArr = [
                `"${row.Vehicle}"`,
                row.Groups,
                row.IdleCost,
                row.SafetyRiskCount,
                row.UtilizationCost,
                row.TotalSavings
            ];
            csvContent += rowArr.join(",") + "\n";
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);

        link.setAttribute("href", url);
        link.setAttribute("download", `ROI_Fleet_Savings_Report_${cachedData.selectedDaysCount}Days.csv`);
        link.style.visibility = 'hidden';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    /**
     * Attach Event Listeners to UI Interactivity
     */
    const attachListeners = () => {
        // Recalculate instantly when math inputs change
        elements.fuelPriceInput.addEventListener('input', updateCalculationsUI);
        elements.stationaryCostInput.addEventListener('input', updateCalculationsUI);
        elements.harshCostInput.addEventListener('input', updateCalculationsUI);
        elements.groupFilterInput.addEventListener('change', updateCalculationsUI);

        // Fetch new API data when Calculate is clicked
        elements.calculateBtn.addEventListener('click', fetchData);

        // Date Validation constraints
        elements.dateFromInput.addEventListener('change', () => {
            if (elements.dateFromInput.valueAsDate > elements.dateToInput.valueAsDate) {
                elements.dateToInput.valueAsDate = elements.dateFromInput.valueAsDate;
            }
        });

        elements.dateToInput.addEventListener('change', () => {
            if (elements.dateToInput.valueAsDate < elements.dateFromInput.valueAsDate) {
                elements.dateFromInput.valueAsDate = elements.dateToInput.valueAsDate;
            }
        });

        // Export Dropdown Logic
        const exportBtn = document.getElementById('export-btn');
        const exportMenu = document.getElementById('export-menu');
        const exportExcelBtn = document.getElementById('export-excel-btn');

        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportMenu.classList.toggle('hidden');
        });

        document.addEventListener('click', () => {
            if (!exportMenu.classList.contains('hidden')) {
                exportMenu.classList.add('hidden');
            }
        });

        exportExcelBtn.addEventListener('click', () => {
            exportToCsv();
        });
    };

    return {
        /**
         * Initialize the Add-In
         */
        initialize: function (api, state, callback) {
            console.log("ROI Calculator Add-in: Initialized");

            // Initialize the API Service
            apiService = new window.GeotabApiService(api);

            setDefaultDates();
            attachListeners();

            if (callback) callback();
        },

        /**
         * Focus: Page is visible
         */
        focus: function (api, state) {
            console.log("ROI Calculator Add-in: Focused");
            // Automatically fetch data when the add-in is opened
            fetchData();
        },

        /**
         * Blur: Page is hidden
         */
        blur: function () {
            console.log("ROI Calculator Add-in: Blurred");
            // No cleanup needed
        }
    };
};
