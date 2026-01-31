# Plan: Force-Directed Network Layout View

## Summary

Add a true force-directed network graph view (`force_network.js`) that users switch to via the existing "Network Mode" radio buttons. Currently both radio options render TimeArcs with different coloring. After this change, selecting "Force Layout" renders a node-link network diagram.

## New File

### `force_network.js` (ES6 module, ~400 LOC)

**Exports:**
- `renderForceNetwork(config)` - Render the network graph into `#chart` SVG
- `cleanupForceNetwork()` - Stop simulation, remove elements
- `isForceNetworkActive()` - Check if network view is active
- `updateForceNetworkVisibility(visibleAttacks)` - Filter edges/nodes by legend selection

**Data aggregation (internal):**
- `aggregateLinksForNetwork(links)` - Collapse per-minute links into per-pair totals with dominant attack type, total count, minute count
- `buildNetworkNodes(edges)` - Derive nodes from edges with degree, totalTraffic, dominant attack

**Force simulation:**
- `d3.forceLink` - distance inversely proportional to connection weight
- `d3.forceManyBody` - repulsion (-300 strength, 500 max distance)
- `d3.forceCenter` - center graph in viewport
- `d3.forceCollide` - prevent node overlap (radius + 4px padding)
- Alpha decay 0.02, velocity decay 0.3

**Rendering:**
- SVG structure: `g.network-container > g.network-edges + g.network-nodes`
- Edges: `<line>` colored by dominant attack, width by log-scaled count (0.5-6px)
- Nodes: `<g>` with `<circle>` sized by sqrt(degree) (5-30px radius), colored by dominant non-normal attack, white stroke; `<text>` label below
- Simulation tick updates positions each frame

**Interactions:**
- **Drag**: d3.drag on nodes, pins during drag, releases on end
- **Hover**: highlight connected edges (opacity 0.9), dim others (0.1); dim unconnected nodes (0.15); show tooltip with IP, degree, traffic, attack breakdown
- **Click**: sticky highlight (click again or background to deselect)
- **Zoom/Pan**: d3.zoom on SVG (scale 0.2-5x), transforms `g.network-container`

**Resize handling:**
- Update forceCenter target, reheat simulation slightly (alpha 0.3)

## Modified Files

### `attack_timearcs.js`

1. **Add import** (top, with existing imports):
   ```js
   import { renderForceNetwork, cleanupForceNetwork, isForceNetworkActive, updateForceNetworkVisibility } from './force_network.js';
   ```

2. **Replace radio handler** (lines 237-244) with mode-switching logic:
   - `timearcs → force_layout`: cleanup TimeArcs, hide TimeArcs-specific UI (bifocal bar, axis, brush controls, compression slider), call `renderForceNetwork()` with current data/links/colors/legend callbacks
   - `force_layout → timearcs`: call `cleanupForceNetwork()`, restore TimeArcs UI, call `render(originalData)`
   - Same mode: existing `updateLabelMode()` behavior

3. **Add UI toggle helpers**:
   - `hideTimeArcsUI()` - hide bifocal bar, axis-top, brush status, compression slider
   - `showTimeArcsUI()` - restore those elements

4. **Guard in `applyAttackFilter()`** (~line 972): if `isForceNetworkActive()`, call `updateForceNetworkVisibility(visibleAttacks)` instead of re-rendering TimeArcs

5. **Guard in resize handler** (~line 457): if `isForceNetworkActive()`, skip TimeArcs resize logic

### `attack_timearcs.css`

Add classes for network elements:
- `.network-edge` - fill none, pointer-events stroke, opacity transition
- `.network-node circle` - cursor grab/grabbing, opacity transition
- `.node-label` - 9px, gray, no pointer events
- `.network-node.dimmed`, `.network-edge.dimmed` - low opacity
- `.network-edge.highlighted` - high opacity

### `attack_timearcs.html`

No structural changes required. Optionally rename "Force Layout" label to "Network Graph" for clarity.

## Verification

1. Serve directory: `python -m http.server 8000`
2. Open `http://localhost:8000/attack_timearcs.html`
3. Load CSV data (or let default CSV load)
4. Verify TimeArcs renders normally
5. Click "Force Layout" / "Network Graph" radio button
6. Verify: TimeArcs-specific UI hides, force-directed graph appears with nodes and edges
7. Test: node dragging, hover tooltips, click highlight, zoom/pan
8. Test: legend filtering dims/hides edges and nodes
9. Switch back to "TimeArcs" - verify TimeArcs re-renders correctly
10. Test window resize in both modes
