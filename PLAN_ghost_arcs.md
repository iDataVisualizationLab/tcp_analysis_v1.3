# Ghost Arcs Implementation Plan

## Problem Statement

In `ip_bar_diagram.js`, packet connections between IP pairs are only visible on hover. This makes it difficult for users to understand communication patterns at a glance. Users must manually hover over each circle to discover which IPs communicate with which.

## Solution: Ghost Arcs

Render all IP-pair arcs persistently with very low opacity (0.02-0.05). Where many arcs overlap, the accumulated opacity creates visible "density bands" showing heavy communication paths. On hover, individual arcs become prominent while others fade further.

### Visual Effect
```
Low traffic:     ░░░░░░░░░  (barely visible, single faint arc)
Medium traffic:  ▒▒▒▒▒▒▒▒▒  (noticeable, overlapping arcs accumulate)
High traffic:    ▓▓▓▓▓▓▓▓▓  (prominent band, many overlapping arcs)
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  New Layer Structure                                         │
│                                                              │
│  mainGroup                                                   │
│  ├── ghostArcLayer (new)     ← persistent, ultra-low opacity │
│  ├── fullDomainLayer         ← existing bars/circles         │
│  ├── dynamicLayer            ← existing zoom-level data      │
│  └── hover-arc (transient)   ← existing, on mouseover        │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Phase 1: Create Ghost Arc Layer Infrastructure

**File: `ip_bar_diagram.js`**

1. **Add new layer variable** (near line 199)
   ```javascript
   let ghostArcLayer = null;
   ```

2. **Initialize layer in SVG setup** (in `initializeVisualization()`)
   - Create `ghostArcLayer` as first child of `mainGroup` (renders behind everything)
   - Set base styling: `pointer-events: none`, `fill: none`

3. **Add state tracking** (in `state` object)
   ```javascript
   state.ui.ghostArcsEnabled = true;  // toggle via UI
   state.ui.ghostArcOpacity = 0.03;   // configurable base opacity
   ```

### Phase 2: Create Ghost Arc Rendering Module

**File: `src/rendering/ghostArcs.js` (new)**

1. **Export `renderGhostArcs(layer, data, options)`**
   - Input: layer selection, packet/binned data, rendering options
   - Groups packets by IP pair to avoid duplicate arcs for same pair at same time bin
   - Uses existing `arcPathGenerator()` for path generation

2. **Key functions:**
   ```javascript
   /**
    * Render ghost arcs for all visible IP pairs.
    * Uses additive blending so overlapping arcs appear denser.
    */
   export function renderGhostArcs(layer, data, options) { ... }

   /**
    * Update ghost arc opacity (for hover dimming).
    */
   export function dimGhostArcs(layer, excludePair) { ... }

   /**
    * Restore ghost arcs to default opacity.
    */
   export function restoreGhostArcs(layer) { ... }
   ```

3. **Aggregation strategy:**
   - Group by `(ipPairKey, timeBin)` to avoid drawing 1000 arcs for 1000 packets at same position
   - One arc per unique IP-pair per visible time bin
   - Arc stroke-width scales with packet count in that bin (subtle variation)

### Phase 3: Integrate with Render Pipeline

**File: `ip_bar_diagram.js`**

1. **Call ghost arc rendering** in `renderData()` or `updateVisualization()`
   - After data is binned but before circle/bar rendering
   - Only render for visible time domain (performance)

2. **Coordinate with zoom:**
   - On zoom/pan, update ghost arcs for new visible domain
   - Use same binning as circles for consistency

3. **Coordinate with IP filtering:**
   - When IPs are filtered, only show ghost arcs for selected IP pairs
   - Listen to `state.filter.selectedIPs` changes

### Phase 4: Enhance Hover Interactions

**File: `src/rendering/circles.js`**

1. **On circle hover:**
   - Dim all ghost arcs to opacity 0.01 (nearly invisible)
   - Keep existing hover-arc behavior (prominent single arc)
   - Highlight the specific IP pair's ghost arcs slightly (opacity 0.1)

2. **On circle mouseout:**
   - Restore all ghost arcs to base opacity
   - Remove hover-arc as before

**File: `src/rendering/ghostArcs.js`**

3. **Add hover coordination functions:**
   ```javascript
   export function highlightPairGhostArcs(layer, ipPairKey, highlightOpacity) { ... }
   export function dimAllExcept(layer, ipPairKey, dimOpacity) { ... }
   ```

### Phase 5: Performance Optimizations

1. **Limit arc count:**
   - Maximum ~2000 ghost arcs visible at once
   - If more, increase time bin size for ghost arcs specifically
   - Or sample representative arcs per IP pair

2. **Use CSS for opacity transitions:**
   ```css
   .ghost-arc {
     transition: stroke-opacity 150ms ease-out;
   }
   ```

3. **Debounce updates:**
   - Don't re-render ghost arcs on every zoom event
   - Debounce to ~100ms after zoom ends

4. **Layer caching:**
   - Cache ghost arc paths when IP positions don't change
   - Only recalculate when y-positions update or time domain changes significantly

### Phase 6: UI Controls

**File: `ip_bar_diagram.html` or sidebar controls**

1. **Add toggle switch:** "Show connection hints" (ghost arcs on/off)

2. **Add opacity slider:** Allow users to adjust ghost arc visibility (0.01 - 0.10)

3. **Persist preference:** Save to localStorage

---

## Data Flow

```
packets/binned data
       │
       ▼
┌──────────────────┐
│ Group by IP pair │  ← Deduplicate same-pair same-time
│ + time bin       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Generate arc     │  ← Use existing arcPathGenerator
│ paths            │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Render to        │  ← D3 path elements with ultra-low opacity
│ ghostArcLayer    │
└──────────────────┘
```

---

## Key Code Locations

| Component | File | Line(s) |
|-----------|------|---------|
| Arc path generation | `src/rendering/arcPath.js` | 48-98 |
| Circle rendering + hover | `src/rendering/circles.js` | 23-185 |
| IP pair key creation | `src/rendering/circles.js` | 12-15 |
| Main render pipeline | `ip_bar_diagram.js` | 322-326 |
| Layer initialization | `ip_bar_diagram.js` | 198-200 |
| IP position calculation | `src/layout/ipPositioning.js` | all |

---

## CSS Classes

```css
.ghost-arc {
  fill: none;
  pointer-events: none;
  stroke-linecap: round;
  transition: stroke-opacity 150ms ease-out;
}

.ghost-arc.dimmed {
  stroke-opacity: 0.005 !important;
}

.ghost-arc.highlighted {
  stroke-opacity: 0.15 !important;
}
```

---

## Configuration Constants

**File: `src/config/constants.js`**

```javascript
// Ghost arc settings
export const GHOST_ARC_BASE_OPACITY = 0.03;
export const GHOST_ARC_DIM_OPACITY = 0.005;
export const GHOST_ARC_HIGHLIGHT_OPACITY = 0.12;
export const GHOST_ARC_MAX_COUNT = 2000;
export const GHOST_ARC_STROKE_WIDTH = 1;
```

---

## Testing Checklist

- [ ] Ghost arcs appear for all IP pairs when page loads
- [ ] Overlapping arcs create visible density bands
- [ ] Ghost arcs update correctly on zoom/pan
- [ ] Ghost arcs filter correctly when IPs are selected
- [ ] Hover dims ghost arcs and shows prominent hover-arc
- [ ] Mouseout restores ghost arc opacity
- [ ] Performance acceptable with 1000+ unique IP pairs
- [ ] Toggle control hides/shows ghost arcs
- [ ] Opacity slider adjusts visibility in real-time

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Too many arcs → slow rendering | Aggregate by time bin, limit max count |
| Arcs obscure packet circles | Render ghost layer behind data layers |
| Opacity too low → invisible | Provide user opacity control |
| Opacity too high → cluttered | Default to conservative 0.03 |
| Memory usage with many paths | Reuse path elements, clear on domain change |

---

## Future Enhancements

1. **Color by flag type:** Ghost arcs colored faintly by predominant TCP flag
2. **Animated flow:** Subtle pulse animation along high-traffic arcs
3. **Bundled arcs:** Group arcs going to same destination into ribbons
4. **Proximity hover:** Start showing arcs when mouse approaches row, not just on circle
