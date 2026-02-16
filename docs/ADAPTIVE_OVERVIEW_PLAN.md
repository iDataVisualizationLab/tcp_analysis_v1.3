# Adaptive Overview Chart: Multi-Resolution Preprocessing Plan

## Quick Start

**Status: IMPLEMENTED** - Multi-resolution pyramid files have been generated.

```bash
# Generate all resolution levels (already done)
cd /Volumes/Extreme\ Pro/combined_tcp_visualization/packets_data
python generate_flow_bins_v3.py --input-dir attack_flows_day1to5_v3 --bin-width-minutes 1 --output-suffix "_1min"
python generate_flow_bins_v3.py --input-dir attack_flows_day1to5_v3 --bin-width-minutes 10 --output-suffix "_10min"
python generate_flow_bins_v3.py --input-dir attack_flows_day1to5_v3 --bin-width-minutes 60 --output-suffix "_hour"
```

### Generated Files

| File | Bin Width | Bins | Size | Use When |
|------|-----------|------|------|----------|
| `flow_bins_1min.json` | 1 min | 1,135 | 1.9 MB | < 30 min zoom |
| `flow_bins_10min.json` | 10 min | 321 | 784 KB | 30 min - 5 hr zoom |
| `flow_bins_hour.json` | 60 min | 97 | 606 KB | > 5 hr zoom |
| `flow_bins_index.json` | - | - | 1 KB | Resolution selector |
| **Total** | | | **3.3 MB** | |

---

## Problem Statement

### Current Limitation

The overview chart in `overview_chart.js` uses a fixed number of bins (100) across the entire 5-day dataset:

- **5 days** = 432,000 seconds = 7,200 minutes
- **100 bins** over 5 days = **72 minutes per bin**
- User selects **5 minutes** → sees only **~1 bin** (useless detail)

### Root Cause

The current `flow_bins.json` pre-aggregates data at a single resolution optimized for the full time range. When users zoom into smaller time windows, the bins are too coarse to show meaningful patterns.

### Current Data Flow

```
User selects IPs → Load flow_bins.json → Filter by IP pairs → Render 100 bins
                                                                    ↓
                                              Problem: bins too coarse for zoom
```

## Proposed Solution: Multi-Resolution Pyramid

Inspired by [FTSPlot](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0094694) and [MAP-Vis](https://www.mdpi.com/2076-3417/10/2/598), we pre-compute aggregates at multiple time resolutions.

### Resolution Levels

| Level | Resolution | Bin Width | Bins (5 days) | Use Case |
|-------|------------|-----------|---------------|----------|
| L0 | minutes | 1 min | ~7,200 | < 30 min selection |
| L1 | 10min | 10 min | ~720 | 30 min - 5 hour selection |
| L2 | hour | 60 min | ~120 | > 5 hour selection |

### Adaptive Selection Logic

```
User Selection        Resolution Used       Bins Shown
─────────────────────────────────────────────────────
5 minutes          →  1-minute bins      →  ~5 bins
30 minutes         →  1-minute bins      →  ~30 bins
2 hours            →  10-minute bins     →  ~12 bins
12 hours           →  10-minute bins     →  ~72 bins
5 days             →  1-hour bins        →  ~120 bins
```

### New Data Flow

```
User selects IPs + time range
         ↓
Select appropriate resolution based on time range
         ↓
Load resolution file (cached after first load)
         ↓
Filter by IP pairs + aggregate visible bins
         ↓
Render adaptive bins (always ~50-150 visible bins)
```

## File Structure

### Index Files (IMPLEMENTED)

```
packets_data/attack_flows_day1to5_v3/
├── manifest.json
├── indices/
│   ├── bins.json                 # Existing: packet counts
│   ├── flow_bins.json            # Legacy: 10-min bins (can be removed)
│   ├── flow_bins_index.json      # NEW: resolution selector
│   ├── flow_bins_1min.json       # NEW: 1-minute resolution (1.9 MB)
│   ├── flow_bins_10min.json      # NEW: 10-minute resolution (784 KB)
│   └── flow_bins_hour.json       # NEW: 1-hour resolution (606 KB)
├── flows/
│   └── by_pair/                  # Source data (unchanged)
└── ips/
    └── ...
```

### flow_bins_index.json Format (IMPLEMENTED)

```json
{
  "resolutions": {
    "1min": {
      "file": "flow_bins_1min.json",
      "bin_width_minutes": 1,
      "bin_width_us": 60000000,
      "bins_with_data": 1135,
      "use_when_range_minutes_lte": 30
    },
    "10min": {
      "file": "flow_bins_10min.json",
      "bin_width_minutes": 10,
      "bin_width_us": 600000000,
      "bins_with_data": 321,
      "use_when_range_minutes_lte": 300
    },
    "hour": {
      "file": "flow_bins_hour.json",
      "bin_width_minutes": 60,
      "bin_width_us": 3600000000,
      "bins_with_data": 97,
      "use_when_range_minutes_gt": 300
    }
  },
  "time_range": {
    "start_us": 1257254652674641,
    "end_us": 1257654012674641,
    "duration_minutes": 6656
  },
  "total_flows": 5482939,
  "total_ip_pairs": 574
}
```

### overview_{resolution}.json Format

```json
{
  "meta": {
    "resolution": "minutes",
    "bin_width_us": 60000000,
    "bin_width_minutes": 1,
    "time_start": 1257254652674641,
    "time_end": 1257654102004202,
    "total_bins": 6658,
    "total_pairs": 574
  },
  "columns": [
    "graceful", "abortive", "ongoing", "open",
    "rst_during_handshake", "invalid_ack", "invalid_synack",
    "incomplete_no_synack", "incomplete_no_ack", "unknown_invalid"
  ],
  "pairs": {
    "172.28.4.7<->19.202.221.71": {
      "0": [0, 0, 0, 0, 0, 0, 0, 8687, 132, 0],
      "1": [0, 0, 0, 0, 0, 0, 0, 9173, 47, 0],
      "5": [0, 0, 0, 0, 0, 0, 0, 500, 10, 0]
    },
    "172.28.1.134<->205.63.202.67": {
      "0": [0, 1, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  },
  "ip_to_pairs": {
    "172.28.4.7": ["120.5.53.166<->172.28.4.7", "172.28.4.7<->19.202.221.71"],
    "19.202.221.71": ["172.28.4.7<->19.202.221.71"]
  }
}
```

**Key Design Decisions:**

1. **Sparse storage**: Only bins with data are stored (keys are bin indices as strings)
2. **Array encoding**: Counts stored as arrays matching `columns` order (compact)
3. **IP-to-pairs index**: O(1) lookup for finding all pairs containing an IP
4. **Per-pair organization**: O(1) lookup per selected pair

### Actual File Sizes (IMPLEMENTED)

| Resolution | Bins (with data) | Actual Size |
|------------|------------------|-------------|
| 1min | 1,135 | 1.9 MB |
| 10min | 321 | 784 KB |
| hour | 97 | 606 KB |
| index | - | 1 KB |
| **Total** | | **3.3 MB** |

Note: Sparse storage means only bins with data are stored, significantly reducing file sizes.

## Implementation Plan

### Phase 1: Python Preprocessing Script ✅ COMPLETE

**File:** `packets_data/generate_flow_bins_v3.py`

**Responsibilities:**
1. Read existing chunk files from `flows/by_pair/*/chunk_*.json` (has precise timestamps)
2. Extract `startTime`, `closeType`, `invalidReason` from each flow
3. Re-aggregate at each resolution level (1-min, 10-min, 1-hour)
4. Generate sparse JSON files
5. Generate `flow_bins_index.json`

**Note:** Does NOT require re-running CSV parsing. The existing v3 chunk files contain all needed data.

**Usage:**
```bash
python generate_flow_bins_v3.py --input-dir attack_flows_day1to5_v3 --bin-width-minutes 1 --output-suffix "_1min"
python generate_flow_bins_v3.py --input-dir attack_flows_day1to5_v3 --bin-width-minutes 10 --output-suffix "_10min"
python generate_flow_bins_v3.py --input-dir attack_flows_day1to5_v3 --bin-width-minutes 60 --output-suffix "_hour"
```

**Actual time:** ~2 minutes per resolution (reads 1,318 chunk files, 5.4M flows)

### Phase 2: JavaScript Client Loader ✅ COMPLETE

**File:** `src/data/adaptive-overview-loader.js`

**Responsibilities:**
1. Load `flow_bins_index.json` on init
2. Select appropriate resolution based on time range
3. Cache loaded resolution files (LRU)
4. Filter for selected IP pairs (no aggregation needed - data is pre-binned)
5. Return bins in format expected by `overview_chart.js`

**API:**
```javascript
import { AdaptiveOverviewLoader } from './src/data/adaptive-overview-loader.js';

const loader = new AdaptiveOverviewLoader('packets_data/attack_flows_day1to5_v3');
await loader.loadIndex();

// Get overview data for selected IPs
const data = await loader.getOverviewData(selectedIPs, timeStart, timeEnd, {
    targetBinCount: 100  // optional, defaults to 100
});

// data = {
//   resolution: '1min' | '10min' | 'hour',
//   binWidthUs: 60000000,
//   bins: [{ binIndex, start, end, counts: { graceful, abortive, ... }, totalFlows }],
//   columns: ['graceful', 'abortive', ...],
//   timeRange: { start, end },
//   metadata: { rawBinCount, displayBinCount, selectedPairCount }
// }
```

**Additional Methods:**
- `selectResolution(timeRangeMinutes)` - Get resolution for time range
- `loadResolution(resolution)` - Load and cache resolution file
- `toSyntheticFlows(data)` - Convert to flow objects for legacy compatibility
- `getTimeExtent()` - Get dataset time range
- `getStats()` - Get loader statistics
- `prefetch(resolution)` - Background prefetch resolution
- `clear()` - Clear all cached data

### Phase 3: Integration with overview_chart.js ✅ COMPLETE

**Modifications to `overview_chart.js`:**

1. ✅ Added `createOverviewFromAdaptive(data, options)` function
2. ✅ Accepts pre-aggregated bins from `AdaptiveOverviewLoader`
3. ✅ Handles variable bin widths in rendering
4. ✅ Displays resolution indicator in chart

**Usage:**
```javascript
import { createOverviewFromAdaptive } from './overview_chart.js';
import { AdaptiveOverviewLoader } from './src/data/adaptive-overview-loader.js';

// Initialize loader
const adaptiveLoader = new AdaptiveOverviewLoader(basePath);
await adaptiveLoader.loadIndex();

// When IPs change or time range changes:
const adaptiveData = await adaptiveLoader.getOverviewData(
    selectedIPs,
    timeExtent[0],
    timeExtent[1]
);

// Render directly from pre-aggregated data
createOverviewFromAdaptive(adaptiveData, {
    timeExtent,
    width: chartWidth,
    margins: chartMargins
});
```

### Phase 4: Integration with tcp-analysis.js ✅ COMPLETE

**Implemented changes:**

1. ✅ Added import: `import { AdaptiveOverviewLoader } from './src/data/adaptive-overview-loader.js';`
2. ✅ Added global variable: `let adaptiveOverviewLoader = null;`
3. ✅ Auto-detection of multi-resolution data via `flow_bins_index.json`
4. ✅ Automatic initialization of `AdaptiveOverviewLoader` when v3 data detected
5. ✅ Added `refreshAdaptiveOverview(selectedIPs, timeExtent)` function
6. ✅ Updated `updateIPFilter()` to use adaptive loader when available
7. ✅ Falls back to `refreshFlowOverview()` if adaptive loader not available

**How it works:**

1. When flow data loads, the system checks for `flow_bins_index.json`
2. If found, `AdaptiveOverviewLoader` is initialized and stored globally
3. When IPs are selected, `refreshAdaptiveOverview()` is called
4. The loader selects appropriate resolution based on time range
5. `createOverviewFromAdaptive()` renders the chart
6. Resolution indicator shows current resolution in chart

**Resolution auto-selection:**
- < 30 minutes → 1-minute bins
- 30 min - 5 hours → 10-minute bins
- > 5 hours → 1-hour bins

### Phase 5: Testing & Validation ⏳ TODO

1. Verify bin counts match original `flow_bins.json` when aggregated
2. Test zoom behavior at various time ranges
3. Benchmark loading times vs. current chunk-loading approach
4. Validate memory usage with all resolutions cached

## How IP Selection & Aggregation Works

### Data Structure (Per-Bin, Per-IP-Pair)

```json
{
  "bin": 42,
  "start": 1257257172674641,
  "end": 1257257232674641,
  "flows_by_ip_pair": {
    "172.28.4.7<->19.202.221.71": {
      "graceful": 0,
      "abortive": 0,
      "invalid": { "incomplete_no_synack": 150, "incomplete_no_ack": 3 },
      "ongoing": 0
    },
    "172.28.4.7<->205.63.202.67": {
      "graceful": 2,
      "abortive": 1,
      "invalid": {},
      "ongoing": 0
    },
    "172.28.1.134<->205.63.202.67": {
      "graceful": 0,
      "abortive": 5,
      "invalid": { "rst_during_handshake": 100 },
      "ongoing": 0
    }
  }
}
```

### Client-Side Aggregation Flow

```
User selects IPs: [172.28.4.7, 19.202.221.71, 205.63.202.67]
                              ↓
Generate all pair combinations:
  - 172.28.4.7<->19.202.221.71     ✓ (both selected)
  - 172.28.4.7<->205.63.202.67     ✓ (both selected)
  - 19.202.221.71<->205.63.202.67  ✗ (no data for this pair)
                              ↓
For each visible bin, sum counts from matching pairs:
  Bin 42: graceful=2, abortive=1, invalid={incomplete_no_synack:150, incomplete_no_ack:3}
                              ↓
If too many bins visible (>150), re-aggregate into display bins
                              ↓
Render overview chart bars
```

### Why Per-IP-Pair Storage?

| Approach | Storage | Query for 2 IPs | Query for 10 IPs |
|----------|---------|-----------------|------------------|
| Global totals only | Small | Impossible | Impossible |
| Per-IP | Medium | Sum 2 IPs (overcounts!) | Sum 10 IPs (overcounts!) |
| **Per-IP-Pair** | **Larger** | **Sum 1 pair (exact)** | **Sum 45 pairs (exact)** |

Per-IP storage would **double-count** flows (each flow counted for both src and dst IP).
Per-IP-pair ensures **exact counts** for any IP selection.

### Client-Side Re-Aggregation (When Zoomed Out)

When 5 days are visible with 1-minute bins, we have ~7200 bins but only want ~100 display bins:

```javascript
function rebinForDisplay(fineBins, targetBinCount) {
    const aggregationFactor = Math.ceil(fineBins.length / targetBinCount);
    const displayBins = [];

    for (let i = 0; i < fineBins.length; i += aggregationFactor) {
        const chunk = fineBins.slice(i, i + aggregationFactor);
        const merged = {
            start: chunk[0].start,
            end: chunk[chunk.length - 1].end,
            counts: { graceful: 0, abortive: 0, ongoing: 0, invalid: {} }
        };

        for (const bin of chunk) {
            merged.counts.graceful += bin.counts.graceful;
            merged.counts.abortive += bin.counts.abortive;
            merged.counts.ongoing += bin.counts.ongoing;
            for (const [reason, count] of Object.entries(bin.counts.invalid)) {
                merged.counts.invalid[reason] = (merged.counts.invalid[reason] || 0) + count;
            }
        }

        displayBins.push(merged);
    }

    return displayBins;
}
```

---

## Code Snippets

### Python Generator (Core Logic)

```python
from pathlib import Path
from collections import defaultdict
import json

COLUMNS = [
    "graceful", "abortive", "ongoing", "open",
    "rst_during_handshake", "invalid_ack", "invalid_synack",
    "incomplete_no_synack", "incomplete_no_ack", "unknown_invalid"
]

def load_flows_from_chunks(input_dir: Path):
    """Load all flows from existing chunk files (NOT flow_bins.json)."""
    pairs_dir = input_dir / "flows" / "by_pair"
    all_flows = []

    for pair_dir in pairs_dir.iterdir():
        if not pair_dir.is_dir():
            continue
        pair_key = pair_dir.name.replace('__', '<->').replace('-', '.')

        for chunk_file in sorted(pair_dir.glob("chunk_*.json")):
            with open(chunk_file) as f:
                flows = json.load(f)
            for flow in flows:
                all_flows.append({
                    'pair': pair_key,
                    'time': flow['startTime'],
                    'closeType': flow.get('closeType'),
                    'invalidReason': flow.get('invalidReason')
                })

    return all_flows

def classify_flow(flow):
    """Classify flow into column category."""
    close_type = flow.get('closeType')
    invalid_reason = flow.get('invalidReason')

    if invalid_reason:
        return invalid_reason if invalid_reason in COLUMNS else 'unknown_invalid'
    if close_type == 'graceful':
        return 'graceful'
    if close_type == 'abortive':
        return 'abortive'
    if close_type in ('open', 'ongoing'):
        return close_type
    return 'ongoing'  # default for incomplete

def aggregate_to_resolution(flows, time_start, bin_width_us):
    """Aggregate flows into fixed-width bins at given resolution."""
    pairs_bins = defaultdict(lambda: defaultdict(lambda: [0] * len(COLUMNS)))

    for flow in flows:
        pair_key = flow['pair']
        category = classify_flow(flow)
        if category not in COLUMNS:
            continue

        col_idx = COLUMNS.index(category)
        bin_idx = (flow['time'] - time_start) // bin_width_us
        pairs_bins[pair_key][bin_idx][col_idx] += 1

    # Convert to sparse representation
    result = {}
    for pair_key, bins in pairs_bins.items():
        non_empty = {str(idx): counts for idx, counts in bins.items() if sum(counts) > 0}
        if non_empty:
            result[pair_key] = non_empty

    return result
```

### JavaScript Loader (Core Logic)

```javascript
const RESOLUTION_THRESHOLDS = [
    { maxMinutes: 30, resolution: 'minutes' },
    { maxMinutes: 300, resolution: '10min' },
    { maxMinutes: Infinity, resolution: 'hour' }
];

selectResolution(timeRangeMinutes) {
    for (const { maxMinutes, resolution } of RESOLUTION_THRESHOLDS) {
        if (timeRangeMinutes <= maxMinutes) {
            return resolution;
        }
    }
    return 'hour';
}

async getOverviewData(selectedIPs, timeStart, timeEnd) {
    const timeRangeMinutes = (timeEnd - timeStart) / 60_000_000;
    const resolution = this.selectResolution(timeRangeMinutes);
    const data = await this.loadResolution(resolution);

    // Build selected pair keys
    const selectedPairs = new Set();
    for (let i = 0; i < selectedIPs.length; i++) {
        for (let j = i + 1; j < selectedIPs.length; j++) {
            const [a, b] = [selectedIPs[i], selectedIPs[j]].sort();
            selectedPairs.add(`${a}<->${b}`);
        }
    }

    // Aggregate bins for selected pairs within time range
    const { meta, pairs, columns } = data;
    const binWidthUs = meta.bin_width_us;
    const startBin = Math.floor((timeStart - meta.time_start) / binWidthUs);
    const endBin = Math.ceil((timeEnd - meta.time_start) / binWidthUs);

    const aggregatedBins = new Map();
    for (const pairKey of selectedPairs) {
        const pairData = pairs[pairKey];
        if (!pairData) continue;

        for (const [binIdxStr, counts] of Object.entries(pairData)) {
            const binIdx = parseInt(binIdxStr);
            if (binIdx < startBin || binIdx > endBin) continue;

            if (!aggregatedBins.has(binIdx)) {
                aggregatedBins.set(binIdx, new Array(counts.length).fill(0));
            }
            const agg = aggregatedBins.get(binIdx);
            counts.forEach((c, i) => agg[i] += c);
        }
    }

    return { resolution, binWidthUs, bins: [...aggregatedBins.entries()], columns };
}
```

## Performance Comparison

| Metric | Current (Chunk Loading) | Proposed (Pyramid) |
|--------|-------------------------|-------------------|
| Initial load | Load chunks on demand | Load 1 resolution file |
| IP selection change | Re-fetch matching chunks | Filter cached data |
| Zoom/time change | No adaptation | Switch resolution + filter |
| Memory (cached) | Variable (chunks) | ~4-6 MB (all resolutions) |
| Network requests | Many small requests | 1-3 requests total |

## Migration Path

1. **Generate pyramid files** alongside existing `flow_bins.json`
2. **Add feature flag** to switch between old/new loading
3. **Test thoroughly** with various IP selections and zoom levels
4. **Remove chunk-loading fallback** once stable

## References

- [FTSPlot: Fast Time Series Visualization for Large Datasets](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0094694)
- [MAP-Vis: Multi-Dimensional Aggregation Pyramid Framework](https://www.mdpi.com/2076-3417/10/2/598)
- [Dynamic Heatmap Pyramid Computation](https://www.tandfonline.com/doi/full/10.1080/17538947.2024.2368099)
- [Efficient Time Series Analysis in Python](https://www.geeksforgeeks.org/efficient-and-scalable-time-series-analysis-with-large-datasets-in-python/)
