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
        fuelPriceInput: document.getElementById('fuel-price'),
        hourlyWageInput: document.getElementById('hourly-wage'),
        accidentCostInput: document.getElementById('accident-cost'),
        calculateBtn: document.getElementById('calculate-btn'),
        loadingOverlay: document.getElementById('loading-overlay'),

        // Output cards
        metricIdle: document.getElementById('metric-idle-cost'),
        detailIdle: document.getElementById('detail-idle'),
        metricSafety: document.getElementById('metric-safety-risk'),
        detailSafety: document.getElementById('detail-safety'),
        metricUtil: document.getElementById('metric-utilization'),
        detailUtil: document.getElementById('detail-util'),
        metricTotal: document.getElementById('metric-total-savings')
    };

    // Core Constants for calculations (Assumptions)
    const IDLE_FUEL_BURN_RATE_GPH = 0.5; // Average gallons per hour consumed while idling
    const AVG_MONTHLY_VEHICLE_COST = 500; // Sunk cost assumption for an underutilized asset per month

    // Add-in state
    let cachedData = {
        selectedDaysCount: 30, // Default for first load
        devices: [],
        deviceGroupsMap: {},
        idleHoursData: { totalHours: 0, deviceIdling: {} },
        harshEventsData: { totalCount: 0, deviceHarshCounts: {} },
        utilizationData: { underutilizedCount: 0, deviceUtilization: {} },
        tableRows: [] // Used for export
    };

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
     * Renders the calculated mathematical results back to the UI
     */
    const updateCalculationsUI = () => {
        // Inputs
        const fuelPrice = parseFloat(elements.fuelPriceInput.value) || 0;
        const driverWage = parseFloat(elements.hourlyWageInput.value) || 0;
        const accidentCost = parseFloat(elements.accidentCostInput.value) || 0;
        const days = cachedData.selectedDaysCount || 30;
        const dailyVehicleCost = AVG_MONTHLY_VEHICLE_COST / 30;

        // 1. Top Level Metrics
        const idleFuelCostTotal = cachedData.idleHoursData.totalHours * IDLE_FUEL_BURN_RATE_GPH * fuelPrice;
        const idleWageCostTotal = cachedData.idleHoursData.totalHours * driverWage;
        const totalIdleCost = idleFuelCostTotal + idleWageCostTotal;

        const incidentProbability = 1 / 1000;
        const safetyCostTotal = cachedData.harshEventsData.totalCount * incidentProbability * accidentCost;

        const utilCostTotal = cachedData.utilizationData.underutilizedCount * dailyVehicleCost * days;

        const totalSavings = totalIdleCost + safetyCostTotal + utilCostTotal;

        // Update Top Cards
        elements.metricIdle.textContent = formatCurrency(totalIdleCost);
        elements.detailIdle.textContent = `${formatNumber(cachedData.idleHoursData.totalHours)} hours of excess idling`;

        elements.metricSafety.textContent = formatCurrency(safetyCostTotal);
        elements.detailSafety.textContent = `${formatNumber(cachedData.harshEventsData.totalCount)} harsh events`;

        elements.metricUtil.textContent = formatCurrency(utilCostTotal);
        elements.detailUtil.textContent = `${formatNumber(cachedData.utilizationData.underutilizedCount)} vehicles w/ no trips`;

        elements.metricTotal.textContent = formatCurrency(totalSavings);

        // Update detail text to reflect dynamic dates
        const totalCardDetail = document.querySelector('.total-card .detail');
        if (totalCardDetail) {
            totalCardDetail.textContent = `Over the selected ${days} days`;
        }

        // 2. Build Table Data
        const tbody = document.getElementById('asset-table-body');
        tbody.innerHTML = ''; // Clear
        cachedData.tableRows = [];

        if (!cachedData.devices || cachedData.devices.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No devices found in this period.</td></tr>`;
            return;
        }

        // Sort devices alphabetically
        const sortedDevices = [...cachedData.devices].sort((a, b) => a.name.localeCompare(b.name));

        sortedDevices.forEach(device => {
            const devId = device.id;

            // Device specific math
            const devIdleHours = cachedData.idleHoursData.deviceIdling[devId] || 0;
            const devIdleCost = (devIdleHours * IDLE_FUEL_BURN_RATE_GPH * fuelPrice) + (devIdleHours * driverWage);

            const devHarshCount = cachedData.harshEventsData.deviceHarshCounts[devId] || 0;
            const devSafetyCost = devHarshCount * incidentProbability * accidentCost;

            const isUnderutilized = cachedData.utilizationData.deviceUtilization[devId];
            const devUtilCost = isUnderutilized ? (dailyVehicleCost * days) : 0;

            const devTotalPotentialSavings = devIdleCost + devSafetyCost + devUtilCost;

            // Only show rows that actually have potential savings to keep table clean
            if (devTotalPotentialSavings > 0) {
                const tr = document.createElement('tr');
                const groupsStr = cachedData.deviceGroupsMap[devId] || 'No Group';

                tr.innerHTML = `
                    <td>${device.name}</td>
                    <td>${groupsStr}</td>
                    <td>${formatCurrency(devIdleCost)}</td>
                    <td>${formatCurrency(devSafetyCost)}</td>
                    <td class="util-col">${formatCurrency(devUtilCost)}</td>
                    <td><strong>${formatCurrency(devTotalPotentialSavings)}</strong></td>
                `;
                tbody.appendChild(tr);

                // Save for export format (raw numbers for CSV)
                cachedData.tableRows.push({
                    Vehicle: device.name,
                    Groups: `"${groupsStr}"`,
                    IdleCost: devIdleCost.toFixed(2),
                    SafetyRisk: devSafetyCost.toFixed(2),
                    UtilizationCost: devUtilCost.toFixed(2),
                    TotalSavings: devTotalPotentialSavings.toFixed(2)
                });
            }
        });

        if (cachedData.tableRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No actionable savings found for selected criteria.</td></tr>`;
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
            const groupMap = await apiService.getDeviceGroupsMap();

            console.log("ROI Calculator: Fetching idle duration...");
            const idleHoursData = await apiService.getIdleDurationPerDevice(fromDate, toDate);

            console.log("ROI Calculator: Fetching harsh driving data...");
            const harshEventsData = await apiService.getHarshDrivingPerDevice(fromDate, toDate);

            console.log("ROI Calculator: Fetching trip utilization...");
            const utilizationData = await apiService.getUtilizationPerDevice(devices, fromDate, toDate);

            // Cache data
            cachedData = {
                devices,
                deviceGroupsMap: groupMap,
                idleHoursData,
                harshEventsData,
                utilizationData,
                tableRows: []
            };

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

        const headers = ["Vehicle", "Groups", "Idle Cost ($)", "Safety Risk ($)", "Utilization Cost ($)", "Total Savings ($)"];
        let csvContent = headers.join(",") + "\n";

        cachedData.tableRows.forEach(row => {
            const rowArr = [
                `"${row.Vehicle}"`,
                row.Groups,
                row.IdleCost,
                row.SafetyRisk,
                row.UtilizationCost,
                row.TotalSavings
            ];
            csvContent += rowArr.join(",") + "\n";
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);

        const days = elements.dateRangeInput.value;
        link.setAttribute("href", url);
        link.setAttribute("download", `ROI_Fleet_Savings_Report_${days}Days.csv`);
        link.style.visibility = 'hidden';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    /**
     * Attach Event Listeners to UI Interactivity
     */
    const attachListeners = () => {
        // Recalculate instantly when inputs change (no API fetch needed)
        elements.fuelPriceInput.addEventListener('input', updateCalculationsUI);
        elements.hourlyWageInput.addEventListener('input', updateCalculationsUI);
        elements.accidentCostInput.addEventListener('input', updateCalculationsUI);

        // Fetch new data when Calculate button clicked
        elements.calculateBtn.addEventListener('click', fetchData);

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
