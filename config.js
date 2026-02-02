// Centralized configuration shared across modules
// Change binning count here to affect all charts
export const GLOBAL_BIN_COUNT = 300;

// Maximum number of flows to render in the control panel list for performance
// Set to a reasonable default; adjust as needed
export const MAX_FLOW_LIST_ITEMS = 500;

// Batch size for incremental DOM rendering of flows list
export const FLOW_LIST_RENDER_BATCH = 200;

// Batch size for chunked flow reconstruction progress updates
export const FLOW_RECONSTRUCT_BATCH = 5000;
