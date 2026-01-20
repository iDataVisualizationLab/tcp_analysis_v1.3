# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **dual-visualization network traffic analysis system** built with D3.js v7 for analyzing TCP packet data and attack patterns. It provides two complementary views:

1. **Network TimeArcs** (`attack_timearcs.html` → `attack_timearcs2.js`) - Arc-based visualization of attack events over time with force-directed IP positioning
2. **TCP Connection Analysis** (`ip_bar_diagram.html` → `ip_bar_diagram.js`) - Detailed packet-level visualization with stacked bar charts and flow reconstruction

## Running the Application

This is a static HTML/JavaScript application. Serve the directory with any HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js (npx)
npx serve .

# Then open:
# http://localhost:8000/attack_timearcs.html  (TimeArcs view)
# http://localhost:8000/ip_bar_diagram.html   (TCP Analysis view)
```

The `index.html` redirects to `attack_timearcs.html` by default.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Main Visualizations                                     │
│  attack_timearcs2.js (~3900 LOC) - Arc network view      │
│  ip_bar_diagram.js (~4600 LOC)   - Packet analysis view  │
│  ip_arc_diagram.js (~3900 LOC)   - IP arc diagram view   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│  Supporting Modules                                      │
│  sidebar.js      - IP/flow selection UI                  │
│  legends.js      - Legend rendering                      │
│  overview_chart.js - Stacked flow overview + brush nav   │
│  folder_integration.js (~1300 LOC) - Folder data coord   │
│  folder_loader.js - Chunked folder data loading          │
│  viewer_loader.js - Viewer initialization utilities      │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│  /src Modular System (ES6 modules)                       │
│                                                          │
│  rendering/   bars.js, circles.js, arcPath.js, rows.js   │
│               arcInteractions.js, tooltip.js             │
│  scales/      scaleFactory.js, distortion.js (fisheye)   │
│  layout/      forceSimulation.js, barForceLayout.js      │
│  interaction/ zoom.js, dragReorder.js, resize.js         │
│  data/        binning.js, csvParser.js, flowReconstruction.js
│               resolution-manager.js, data-source.js      │
│               component-loader.js, csv-resolution-manager.js
│               aggregation.js                              │
│  tcp/         flags.js (TCP flag classification)         │
│  groundTruth/ groundTruth.js (attack event loading)      │
│  mappings/    decoders.js, loaders.js                    │
│  workers/     packetWorkerManager.js                     │
│  plugins/     d3-fisheye.js                              │
│  ui/          legend.js                                  │
│  utils/       formatters.js, helpers.js                  │
│  config/      constants.js                               │
└──────────────────────────────────────────────────────────┘
```

### Key Data Flow

1. **CSV Input** → `csvParser.js` stream parsing OR folder-based chunked loading
2. **Packet Objects** → flow reconstruction, force layout positioning
3. **Ground Truth** → `groundTruth.js` loads attack event annotations from CSV
4. **Binning** → adaptive time-based aggregation (`binning.js`)
5. **Resolution Management** → `resolution-manager.js` handles zoom-level data with LRU caching
6. **Rendering** → stacked bars by flag type, arcs between IPs

**Flow Data for Overview Chart** (ip_bar_diagram.js:1703-1743):
- When IPs are selected, `updateIPFilter()` is called (async function)
- Filters `chunks_meta.json` to find chunks containing selected IPs
- **Current approach**: Fetches ALL matching chunk files (e.g., chunk_00000.json, chunk_00001.json, ...)
- Loads full flow objects with `startTime`, `closeType`, `invalidReason` properties
- Filters flows where BOTH `initiator` AND `responder` match selected IPs
- Passes filtered flows to `overview_chart.js` for categorization and binning
- **Limitation**: Slow when thousands of chunks match selected IPs (common for popular IPs like attacker sources)

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

**Folder-based data** (flow-based chunking):
```
packets_data/attack_flows_day1to5/
├── manifest.json          # Dataset metadata (version, format, totals, time range)
├── flows/
│   ├── chunks_meta.json   # Chunk index with flow category summaries per chunk
│   ├── chunk_00000.json   # ~300 flows with full packet data in phases
│   ├── chunk_00001.json
│   └── ...                # (18,277 chunks total for 5.4M flows)
├── indices/
│   └── bins.json          # Time bins with TOTAL packet counts only
│                          # (NOT flow-categorized - insufficient for overview chart)
└── ips/
    ├── ip_stats.json      # Per-IP packet/byte counts
    ├── flag_stats.json    # Global TCP flag distribution
    └── unique_ips.json    # List of all IPs in dataset
```

**Important**: `indices/bins.json` contains only total packet counts per time bin without flow categorization (graceful/abortive/invalid breakdowns). The overview chart currently loads all relevant chunk files to get categorized flow data, which is inefficient. See "Overview Chart" section for recommended `flow_bins.json` solution.

## Key Implementation Details

### Three Main Visualization Files

- `attack_timearcs2.js` (~3900 LOC) - Arc network view with force-directed IP layout
- `ip_bar_diagram.js` (~4600 LOC) - Detailed packet analysis with stacked bars
- `ip_arc_diagram.js` (~3900 LOC) - IP arc diagram variant

All are monolithic files that compose modules from `/src`. They maintain extensive internal state (IP positions, selections, zoom state) and trigger re-renders on state changes.

### Overview Chart

The `overview_chart.js` module (~900 LOC) provides:
- Stacked bar overview of invalid flows by reason
- Brush-based time range selection synced with main chart zoom
- Legend integration for filtering by invalid reason/close type

**Current Implementation** (Optimized with flow_bins.json):
- `ip_bar_diagram.js` loads `flow_bins.json` when flow data is loaded (line 4222-4233)
- Filters pre-aggregated flow bins by selected IP pairs (line 1703-1757)
- Creates synthetic flows from bin data for overview chart
- **Fallback**: If `flow_bins.json` not available, loads chunk files (line 1758-1798)

**flow_bins.json Structure**:
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
- **Instant loading**: 1MB file vs. thousands of chunk files
- **Accurate distribution**: Flows binned by actual timestamps
- **Efficient filtering**: Pre-aggregated by IP pair
- **Reduced memory**: No need to load full flow objects for overview

**Generating flow_bins.json**:
```bash
# From existing chunks (no CSV reprocessing needed)
python generate_flow_bins.py --input-dir attack_flows_day1to5

# Or from scratch (regenerates all data)
python tcp_data_loader_streaming.py --data attack_packets_first5days.csv \
    --ip-map full_ip_map.json --output-dir attack_flows_day1to5
```

### Ground Truth Integration

`src/groundTruth/groundTruth.js` loads attack event annotations from `GroundTruth_UTC_naive.csv`:
- Parses event types, source/destination IPs, port ranges, time windows
- Converts timestamps to microseconds for alignment with packet data
- Filters events by selected IPs for contextual display

### Force-Directed Layout

- **TimeArcs**: Complex multi-force simulation with component separation, hub attraction, y-constraints
- **BarDiagram**: Simpler vertical ordering via `barForceLayout.js`

### Fisheye Distortion

The fisheye lens effect (`src/plugins/d3-fisheye.js`, wrapped by `src/scales/distortion.js`) provides overview+detail zooming. Controlled by the "Lensing" toggle and zoom slider in the UI.

### Performance Optimizations

- **Binning**: Reduces millions of packets to thousands of bins
- **Web Worker**: Packet filtering runs off main thread
- **Layer caching**: Full-domain layer pre-rendered
- **Batch processing**: Flow reconstruction and list rendering use configurable batch sizes
- **LRU Cache**: `resolution-manager.js` caches loaded detail chunks with automatic eviction
- **Multi-resolution loading**: Zoom-level dependent data loading (overview → detail)

## Module Dependencies

Main files import heavily from `/src`:
- **Rendering**: `bars.js`, `circles.js`, `arcPath.js`, `rows.js`, `tooltip.js`, `arcInteractions.js`
- **Data**: `binning.js`, `flowReconstruction.js`, `csvParser.js`, `aggregation.js`, `resolution-manager.js`, `data-source.js`, `component-loader.js`
- **Layout**: `forceSimulation.js`, `barForceLayout.js`
- **Interaction**: `zoom.js`, `arcInteractions.js`, `dragReorder.js`, `resize.js`
- **Scales**: `scaleFactory.js`, `distortion.js`
- **Ground Truth**: `groundTruth.js`
- **Utils**: `formatters.js` (byte/timestamp formatting), `helpers.js`
- **UI**: `legend.js`
- **Config**: `constants.js` (colors, sizes, debug flags)

## Original TimeArcs Source

The `timearcs_source/` directory contains the original TimeArcs implementation for political blog analysis (unrelated to the network traffic visualization).
