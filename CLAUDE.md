# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow Rules
- When asked to write a plan, ONLY write the plan file. Do not attempt to implement, ask to implement, or exit plan mode. Stop after writing the file.

## Project Overview

This is a **dual-visualization network traffic analysis system** built with D3.js v7 for analyzing TCP packet data and attack patterns. It provides two complementary views:

1. **Network TimeArcs** (`attack-network.html` → `attack-network.js`) - Arc-based visualization of attack events over time with force-directed IP positioning. **Default mode: Force layout network view** (2D force-directed network graph); Timearcs Time Line View (arc-based timeline) available via radio toggle
2. **TCP Connection Analysis** (`tcp-analysis.html` → `tcp-analysis.js`) - Detailed packet-level visualization with three named UI components:
   - **Packet View** — main visualization area: stacked circles, arcs, time axis (`#chart-column`)
   - **Overview Bar chart** — stacked flow bars at bottom, brush-navigable time range (`#overview-container`)
   - **Control Panel** — floating draggable panel: IP selection, legends, view controls (`#control-panel`)

## Running the Application

This is a static HTML/JavaScript application. Serve the directory with any HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js (npx)
npx serve .

# Then open:
# http://localhost:8000/attack-network.html  (TimeArcs view)
# http://localhost:8000/tcp-analysis.html   (TCP Analysis view)
```

The `index.html` redirects to `attack-network.html` by default.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Main Visualizations                                     │
│  attack-network.js (~2000 LOC)   - Arc network view      │
│  tcp-analysis.js (~4600 LOC)     - Packet analysis view  │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│  Supporting Modules                                      │
│  control-panel.js - Control Panel UI (drag/collapse)     │
│  sidebar.js      - IP/flow selection UI                  │
│  legends.js      - Legend rendering                      │
│  overview_chart.js - Overview Bar chart + brush nav      │
│  folder_integration.js (~1300 LOC) - Folder data coord   │
│  folder_loader.js - Chunked folder data loading          │
│  viewer_loader.js - Viewer initialization utilities      │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│  /src Modular System (ES6 modules)                       │
│                                                          │
│  rendering/   bars.js, circles.js, arcPath.js, rows.js   │
│               arcInteractions.js, highlightUtils.js      │
│               tooltip.js, svgSetup.js, initialRender.js  │
│  scales/      scaleFactory.js, distortion.js (fisheye)   │
│               bifocal.js (focus+context layout math)     │
│  layout/      forceSimulation.js, force_network.js       │
│               timearcs_layout.js (~1600 LOC, class)      │
│  interaction/ zoom.js, dragReorder.js, resize.js         │
│  data/        binning.js (visible packets, bar width calc) │
│               csvParser.js, flowReconstruction.js        │
│               resolution-manager.js, data-source.js      │
│               component-loader.js, csv-resolution-manager.js│
│               aggregation.js, flow-loader.js             │
│               flow-list-loader.js (lazy CSV loading)     │
│               adaptive-overview-loader.js                │
│               packet-filter.js, flow-data-handler.js     │
│  tcp/         flags.js (TCP flag classification)         │
│  groundTruth/ groundTruth.js (attack event loading)      │
│  mappings/    decoders.js, loaders.js                    │
│  workers/     packetWorkerManager.js                     │
│  plugins/     d3-fisheye.js                              │
│  ui/          legend.js, bifocal-handles.js              │
│               loading-indicator.js                       │
│  utils/       formatters.js, helpers.js                  │
│  config/      constants.js                               │
└──────────────────────────────────────────────────────────┘
```

### Key Data Flow

1. **CSV Input** → `csvParser.js` stream parsing OR folder-based chunked loading
2. **Packet Objects** → flow reconstruction, force layout positioning
3. **Ground Truth** → `groundTruth.js` loads attack event annotations from CSV
4. **Pre-binned Data** → Multi-resolution CSV files loaded by `csv-resolution-manager.js` (hours/minutes/seconds/100ms/10ms/1ms/raw)
5. **Resolution Management** → `resolution-manager.js` handles zoom-level data with LRU caching
6. **Rendering** → stacked bars by flag type, arcs between IPs (`initialRender.js` prepares data, `bars.js`/`circles.js` render)

**Flow Data for Overview Bar chart** (tcp-analysis.js:1703-1757):
- When IPs are selected, `updateIPFilter()` is called (async function)
- Uses adaptive multi-resolution loader (`flow_bins_index.json`) for efficient Overview Bar chart rendering
- Falls back to `flow_bins.json` or chunk loading if multi-resolution not available
- For v3 format (`chunked_flows_by_ip_pair`), filters chunks by IP pair first for efficiency
- Passes filtered/aggregated data to `overview_chart.js` for categorization and binning

### Worker Pattern

`packet_worker.js` handles packet filtering off the main thread:
- Receives packets via `init` message
- Filters by connection keys or IPs
- Returns `Uint8Array` visibility mask
- Managed by `src/workers/packetWorkerManager.js`

## Configuration

- `config.js` - Centralized settings (`GLOBAL_BIN_COUNT`, batch sizes)
- `src/config/constants.js` - Colors, sizes, TCP states

### JSON Mapping Files

- `full_ip_map.json` - IP address → descriptive name
- `attack_group_mapping.json` - Attack type → category
- `attack_group_color_mapping.json` - Category → color
- `event_type_mapping.json` - Event → color
- `flag_colors.json`, `flow_colors.json` - Visual styling

## Data Formats

**TimeArcs CSV**: `timestamp, length, src_ip, dst_ip, protocol, count`

**TCP Analysis CSV**: `timestamp, src_ip, dst_ip, src_port, dst_port, flags, length, ...`

**Folder-based data** (v3 format - `chunked_flows_by_ip_pair`):
```
packets_data/attack_flows_day1to5/
├── manifest.json              # Dataset metadata (version 3.0, format, totals, time range)
├── flows/
│   ├── pairs_meta.json        # IP pair index with per-pair chunk metadata
│   └── by_pair/               # Flows organized by IP pair (efficient filtering)
│       ├── 172-28-4-7__19-202-221-71/
│       │   ├── chunk_00000.json
│       │   ├── chunk_00001.json
│       │   └── ...
│       └── ...                # (574 IP pairs, 1318 total chunks)
├── indices/
│   ├── bins.json              # Time bins with total packet counts
│   ├── flow_bins.json         # Pre-aggregated flows by IP pair (single resolution)
│   ├── flow_bins_index.json   # Multi-resolution index for adaptive loading
│   ├── flow_bins_1s.json      # 1-second resolution bins (for zoomed views)
│   ├── flow_bins_1min.json    # 1-minute resolution bins
│   ├── flow_bins_10min.json   # 10-minute resolution bins
│   ├── flow_bins_hour.json    # Hourly resolution bins
│   └── flow_list/             # Flow summaries for flow list popup (lazy-loaded CSVs)
│       ├── index.json         # IP pair index with file references
│       └── *.csv              # Per-IP-pair CSV files (574 files, ~525MB total)
└── ips/
    ├── ip_stats.json          # Per-IP packet/byte counts
    ├── flag_stats.json        # Global TCP flag distribution
    └── unique_ips.json        # List of all IPs in dataset
```

**Legacy v2 format** (`chunked_flows`) also supported:
```
packets_data/attack_flows_day1to5_v2/
├── manifest.json          # version 2.2, format: chunked_flows
├── flows/
│   ├── chunks_meta.json   # Flat chunk index
│   ├── chunk_00000.json   # ~300 flows per chunk
│   └── ...
└── ...
```

The code auto-detects format from `manifest.json` and loads appropriately.

## Key Implementation Details

### Two Main Visualization Files

- `attack-network.js` (~2000 LOC) - Arc network view orchestrator (data loading, mode switching, UI wiring)
- `tcp-analysis.js` (~4600 LOC) - Detailed packet analysis with stacked bars

Both compose modules from `/src` and maintain extensive internal state (IP positions, selections, zoom state).

### TimearcsLayout Class

`src/layout/timearcs_layout.js` (~1600 LOC) encapsulates the timearcs arc visualization, extracted from `attack-network.js`. Mirrors the `ForceNetworkLayout` pattern: one class with constructor options, separate `setData()` and `render()` calls, and pull-based context retrieval via callbacks.

Key responsibilities:
- Force simulation setup (component separation, hub attraction, y-constraints)
- Arc rendering with gradient coloring by attack type
- IP label layout and hover highlighting
- Bifocal (focus+context) lens distortion
- Drag-to-brush selection system
- Animated transitions between layout modes

**Loading Bar** (`tcp-analysis.html`, `tcp-analysis.css`):
- A progress bar is shown in `tcp-analysis.html` while data is loading on page open
- Disappears once initial render completes

### Overview Bar chart

The `overview_chart.js` module (~900 LOC) provides:
- Stacked bar overview of invalid flows by reason (the **Overview Bar chart**)
- Brush-based time range selection synced with Packet View zoom
- Legend integration for filtering by invalid reason/close type

**Current Implementation** (Multi-resolution adaptive loading):
- `tcp-analysis.js` initializes `AdaptiveOverviewLoader` from `flow_bins_index.json`
- Loader selects appropriate resolution based on visible time range (hour → 10min → 1min)
- Filters pre-aggregated flow bins by selected IP pairs
- Creates synthetic flows from bin data for Overview Bar chart
- **Fallback chain**: adaptive loader → `flow_bins.json` → chunk loading

**Multi-resolution index** (`flow_bins_index.json`):
```json
{
  "resolutions": {
    "1s": { "file": "flow_bins_1s.json", "bin_width_us": 1000000, "use_when_range_minutes_lte": 10 },
    "1min": { "file": "flow_bins_1min.json", "bin_width_us": 60000000, "use_when_range_minutes_lte": 120 },
    "10min": { "file": "flow_bins_10min.json", "bin_width_us": 600000000, "use_when_range_minutes_lte": 7200 },
    "hour": { "file": "flow_bins_hour.json", "bin_width_us": 3600000000, "use_when_range_minutes_gt": 7200 }
  }
}
```

**flow_bins.json Structure** (per resolution):
```json
[
  {
    "bin": 0,
    "start": 1257254652674641,
    "end": 1257258647167936,
    "flows_by_ip_pair": {
      "172.28.1.134<->152.162.178.254": {
        "graceful": 1,
        "abortive": 5,
        "invalid": {
          "rst_during_handshake": 290,
          "invalid_ack": 2,
          "incomplete_no_synack": 1
        },
        "ongoing": 10
      }
    }
  }
]
```

**Benefits**:
- **Adaptive resolution**: Coarse bins for overview, fine bins when zoomed
- **Instant loading**: Small files vs. thousands of chunk files
- **Efficient filtering**: Pre-aggregated by IP pair
- **Reduced memory**: No need to load full flow objects for overview

### Flow List CSV Files (Lazy Loading)

For deployments where chunk files are too large (e.g., GitHub Pages), generate per-IP-pair CSV files. Two scripts are available:

```bash
# Summary only (no packet data) - smaller files
python packets_data/generate_flow_list.py --input-dir packets_data/attack_flows_day1to5

# With embedded packet data (fp column) - enables "View Packets" button
python packets_data/generate_flow_data.py --input-dir packets_data/attack_flows_day1to5
```

**Output Structure**:
```
indices/flow_list/
├── index.json                      # IP pair index (87KB)
├── 172-28-4-7__192-168-1-1.csv    # Flows for this IP pair
├── 172-28-4-7__10-0-0-1.csv       # Another IP pair
└── ...                             # 574 files total (~525MB)
```

**index.json Structure**:
```json
{
  "version": "1.1",
  "format": "flow_list_csv",
  "columns": ["d", "st", "et", "p", "sp", "dp", "ct", "fp"],
  "total_flows": 5482939,
  "total_pairs": 574,
  "unique_ips": 294,
  "time_range": { "start": 1257254652674641, "end": 1257654102004202 },
  "pairs": [
    { "pair": "172.28.4.7<->192.168.1.1", "file": "172-28-4-7__192-168-1-1.csv", "count": 1523 }
  ]
}
```

**CSV Format** (with embedded packet data):
```csv
start_time,src_port,dst_port,close_type,packets
1257254652674641,54321,80,invalid_ack,"0:2:1,159:18:0,578:16:1"
```

- `start_time`: Start time (absolute microseconds)
- `close_type`: Close type (graceful/abortive/ongoing) or invalid reason (invalid_ack, rst_during_handshake, etc.)

The `packets` column contains embedded packet data: `delta_ts:flags:dir,...`
- `delta_ts`: Microseconds relative to flow start time
- `flags`: TCP flags (numeric value)
- `dir`: Direction (1 = ip1→ip2, 0 = ip2→ip1) based on alphabetical IP order from filename
- Initiator = first packet's dir (dir=1 means ip1 initiated, dir=0 means ip2 initiated)
- Packet count = number of comma-separated entries
- Duration = last packet's delta_ts (end_time = start_time + last delta_ts)

**Lazy Loading Behavior**:
- On page load: Only `index.json` is fetched (~87KB)
- On IP selection: No CSV files loaded yet; UI shows "Flow List Available"
- On Overview Bar chart click: Only relevant IP pair CSVs are fetched for the clicked time range
- Loaded CSVs are cached in memory for subsequent requests

**Key Files**:
- `src/data/flow-list-loader.js` - FlowListLoader class for parsing/caching CSVs with `fp` column support
- `src/data/flow-loader.js` - Decision tree that defers loading when FlowListLoader available

**When flow_list CSVs are present**:
- Flow list popup works without loading chunk files
- If `fp` column present: "View Packets" visualizes embedded packet data (no chunk files needed)
- If `fp` column absent: "View Packets" and "Export CSV" buttons are disabled
- Overview Bar chart still uses adaptive flow_bins for visualization
- CSV format is ~45% smaller than JSON; all files under GitHub's 100MB limit

### Packet Data Multi-Resolution (v3.3)

The `csv-resolution-manager.js` handles zoom-level dependent packet data loading with 7 resolution levels:

| Resolution | Bin Size | Auto Threshold |
|------------|----------|----------------|
| hours | 1 hour | > 2 days |
| minutes | 1 minute | > 1 hour |
| seconds | 1 second | > 1 minute |
| 100ms | 100ms | > 10 seconds |
| 10ms | 10ms | > 1 second |
| 1ms | 1ms | > 100ms |
| raw | individual packets | ≤ 100ms |

Coarse resolutions (hours, minutes, seconds) use single-file `data.csv` files loaded at initialization. Fine resolutions (100ms, 10ms, 1ms, raw) use chunked files loaded on-demand with LRU caching.

**Resolution Selection** (`getResolutionForVisibleRange()` in `tcp-analysis.js`):
- **Auto mode**: Threshold-based — picks the coarsest level whose threshold the visible range exceeds
- **Manual override**: Dropdown selects an explicit resolution level. The selected level is used directly. When the user zooms in past the next finer level's threshold, it auto-refines one step at a time (e.g., minutes → seconds → 100ms → ...). Never goes coarser than the selected level.
- The dropdown labels use "+" suffix (e.g., "Minutes+") to indicate zoom-to-finer behavior
- A **current resolution indicator** badge next to the dropdown shows the active resolution (blue = auto, orange = manual override)

**Generating multi-resolution flow bins**:
```bash
# Generate all resolutions from existing v3 data
python packets_data/generate_flow_bins_v3.py --input-dir packets_data/attack_flows_day1to5
```

### Ground Truth Integration

`src/groundTruth/groundTruth.js` loads attack event annotations from `GroundTruth_UTC_naive.csv`:
- Parses event types, source/destination IPs, port ranges, time windows
- Converts timestamps to microseconds for alignment with packet data
- Filters events by selected IPs for contextual display

### IP Pair Layout System

The visualization uses a sophisticated layout system to prevent overlapping when multiple IP pairs share the same source IP row:

**Per-IP Dynamic Row Heights** (`src/layout/ipPositioning.js`):
- `computeIPPairCounts()` counts unique destination IPs per source IP
- Each IP row height is calculated as: `max(ROW_GAP, pairCount * 12 + 8)` pixels
- `ipRowHeights` Map stored in state for rendering access
- Cumulative positioning: each IP's y = previous IP's y + previous IP's row height

**IP Pair Vertical Offsets** (`src/rendering/bars.js`, `src/rendering/circles.js`):
- Pairs within a row are ordered by time of first packet (earliest first)
- Each pair gets a sub-row offset: `pairIndex * (subRowHeight + SUB_ROW_GAP)`
- First pair (index 0) aligns with the IP label baseline
- Subsequent pairs grow downward within the row's allocated height
- `makeIpPairKey(srcIp, dstIp)` creates canonical keys (alphabetically sorted)

**Sub-Row Ghost Arcs** (`src/rendering/circles.js`, `src/rendering/svgSetup.js`):
- Persistent ghost arcs show IP pair connections at the sub-row level
- Rendered as low-opacity arcs connecting each IP pair's sub-row position
- Toggled via a control in the Control Panel
- `svgSetup.js` handles SVG layer setup and hover area sizing; hover hit areas are limited to the IP label width to prevent overlap with chart content

**Row Hover Highlighting**:
- Hovering an IP row uses grey shades (not blue/yellow)
- Highlights all bins in the row that belong to the hovered IP pair, not just the first matching bin

**IP Label Hover Styling** (consistent across all views):
- Hovered IP: bold, black (`#000`)
- Connected IPs: font-weight 500, black (`#000`)
- Non-connected IPs: faded to opacity 0.25
- Applied in `timearcs_layout.js`, `rows.js` (TCP Analysis), and `tcp-analysis.css`

**Circle Hover Callbacks** (`circles.js`):
- `onCircleHighlight(srcIp, dstIps)` — called on circle mouseover; highlights source/destination IP rows and labels
- `onCircleClearHighlight()` — called on circle mouseout; clears all highlights
- TCP Analysis wires these via `renderCirclesWithOptions()` to apply `.highlighted`, `.connected`, `.faded` CSS classes

**Arc Path Connections** (`src/rendering/arcPath.js`):
- `arcPathGenerator()` accepts optional `srcY` and `dstY` for offset positions
- Hover handlers calculate both source and destination offsets using `calculateYPosWithOffset()`
- Arcs connect circle-to-circle at their actual offset positions, not baselines

**Row Collapse Behavior**:
- All IP rows with multiple pairs start **collapsed by default** (`defaultCollapseApplied` flag)
- `state.layout.collapsedIPs` Set tracks which IPs have their sub-rows merged
- Click individual IP labels to expand/collapse; "Collapse All"/"Expand All" buttons rendered inline to the left of each IP row label (not in the Control Panel)
- Collapsed rows merge all pair bins at same (time, yPos, flagType) into single circles

**Key Data Structures**:
```javascript
// ipPairOrderByRow: Map<yPos, { order: Map<ipPairKey, index>, count: number }>
// ipRowHeights: Map<ip, heightInPixels>
// ipPairCounts: Map<ip, numberOfUniquePairs>
// collapsedIPs: Set<ip> - IPs whose sub-rows are collapsed
```

### Force-Directed Layout

- **TimeArcs** (`src/layout/timearcs_layout.js`): Complex multi-force simulation with component separation, hub attraction, y-constraints
- **Force Network** (`src/layout/force_network.js`): 2D force layout used as the **default view mode** in TimeArcs. Aggregates arc data by IP pair + attack type, renders with D3 force simulation. Supports `precalculate()` for pre-computing positions (used during animated transitions) and `staticStart` rendering. On data load, the timearcs render completes first, then auto-transitions to force layout via `transitionToForceLayout()`
- **BarDiagram**: Uses vertical IP order from TimeArcs directly (no separate force layout)

**Network Mode Toggle** (`attack-network.html`):
- Radio buttons switch between "Timearcs Time Line View" (arc timeline) and "Force layout network view" (2D network graph)
- Default: Force layout network view (`layoutMode = 'force_layout'`, `labelMode = 'force_layout'`)
- Force layout uses `attack_group` for coloring; Timearcs uses `attack` (finer-grained)

### Brush Selection System (attack-network.js)

Drag-to-brush selection allows users to select arcs/nodes for analysis and export to tcp-analysis:
- **Persistent selections** (`persistentSelections[]`): Stored at module level as data objects with `{id, timeBounds, ips, arcs, timeRange}`. Survive resize/filter re-renders.
- **`multiSelectionsGroup`**: SVG `<g>` holding selection visuals. Must be reset to `null` in `render()` cleanup (after `svg.selectAll('*').remove()`) so `setupDragToBrush()` creates a fresh DOM group. Forgetting this causes new selections to append to a detached element.
- **`computeSelectionBounds()`**: Recomputes selection rectangle pixel bounds from stored IP names using current scales/node positions (not stale pixel values). Shared by `createPersistentSelectionVisual` and `updatePersistentSelectionVisuals`.
- **`redrawAllPersistentSelections()` / `redrawPersistentSelectionsFn`**: Clears and re-creates all selection DOM elements. Called after positions finalize (timearcs animation end, force layout setup, component layout change) and from the force layout resize handler.
- **Resize behavior**: Timearcs mode calls `render()` which preserves `persistentSelections` and redraws after animation. Force layout mode bypasses `render()` and calls `redrawPersistentSelectionsFn` directly.

### Shared Highlight Logic

`src/rendering/highlightUtils.js` provides shared hover highlight functions used by both timearcs (`arcInteractions.js`) and force layout (`force_network.js`):
- `highlightHoveredLink()` / `unhighlightLinks()` — dim all links, highlight hovered
- `getLinkHighlightInfo()` — compute active IPs and attack color from link datum (handles both timearcs arc shape and force link shape)
- `highlightEndpointLabels()` / `unhighlightEndpointLabels()` — bold, enlarge, color active IP labels; dim others
- `ipFromDatum()` (internal) — normalizes datum to IP string (timearcs labels bind raw strings, force layout nodes bind `{id, degree}` objects)

### Control Panel

The Control Panel (`control-panel.js`) is a `position: fixed` aside with drag-to-move and click-to-collapse behavior:
- **Drag handle**: Title bar at top — click to collapse/expand, drag to reposition
- **Zoom controls bar**: Positioned above the Control Panel via `position: absolute; bottom: 100%`. Contains resolution dropdown, current resolution indicator badge, and zoom +/- buttons. Stays visible when panel is collapsed. Moves with the panel on drag.
- **Controls body**: Scrollable area with IP selection, TCP flags, legends, flow visualization options
- Panel uses `overflow: visible` so the zoom bar (absolutely positioned above) is not clipped

### Fisheye Distortion

The fisheye lens effect (`src/plugins/d3-fisheye.js`, wrapped by `src/scales/distortion.js`) provides overview+detail zooming. Controlled by the "Lensing" toggle and zoom slider in the UI.

### Performance Optimizations

- **Binning**: Reduces millions of packets to thousands of bins
- **Web Worker**: Packet filtering runs off main thread
- **Layer caching**: Full-domain layer pre-rendered
- **Batch processing**: Flow reconstruction and list rendering use configurable batch sizes
- **LRU Cache**: `resolution-manager.js` caches loaded detail chunks with automatic eviction
- **Multi-resolution loading**: Zoom-level dependent data loading (overview → detail)
- **IP-pair organization** (v3): Chunks organized by IP pair enable efficient filtering—only load chunks for selected IP pairs instead of scanning all chunks
- **Adaptive overview resolution**: Coarse bins for full view, fine bins when zoomed (Overview Bar chart)
- **Lazy flow list loading**: CSV files only loaded when user clicks Overview Bar chart bars

## Module Dependencies

Main files import heavily from `/src`:
- **Rendering**: `bars.js`, `circles.js`, `arcPath.js`, `rows.js`, `tooltip.js`, `arcInteractions.js`, `highlightUtils.js`, `svgSetup.js`
- **Data**: `binning.js` (visible packets, bar width), `flowReconstruction.js`, `csvParser.js`, `aggregation.js`, `resolution-manager.js`, `csv-resolution-manager.js`, `data-source.js`, `component-loader.js`, `initialRender.js`
- **Layout**: `forceSimulation.js`, `force_network.js`, `timearcs_layout.js`
- **Interaction**: `zoom.js`, `arcInteractions.js`, `dragReorder.js`, `resize.js`
- **Scales**: `scaleFactory.js`, `distortion.js`, `bifocal.js`
- **Ground Truth**: `groundTruth.js`
- **Utils**: `formatters.js` (byte/timestamp formatting), `helpers.js`
- **UI**: `legend.js`, `bifocal-handles.js`, `loading-indicator.js`
- **Config**: `constants.js` (colors, sizes, debug flags)

## Original TimeArcs Source

The `timearcs_source/` directory contains the original TimeArcs implementation for political blog analysis (unrelated to the network traffic visualization).
