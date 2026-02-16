# Bifocal Display Implementation Plan

Replace the fisheye/lensing effect with a **bifocal display** for timeline zooming in the TimeArcs visualization.

## Overview

A bifocal display divides the timeline into three regions:
1. **Left context** - Compressed view of time before focus
2. **Focus region** - Full-detail view (draggable/resizable)
3. **Right context** - Compressed view of time after focus

Unlike fisheye: sharp transitions, no continuous mouse tracking, context is compressed but readable.

---

## Files to Modify/Create

| File | Action | Changes |
|------|--------|---------|
| `src/scales/bifocal.js` | **CREATE** | Core transform functions, state management |
| `src/ui/bifocal-handles.js` | **CREATE** | Draggable SVG handles for focus region |
| `src/scales/distortion.js` | **MODIFY** | Add bifocal branch to `createLensXScale()` |
| `attack-network.js` | **MODIFY** | Replace lensing state with bifocal state |
| `attack-network.html` | **MODIFY** | Update UI controls |

---

## Implementation Steps

### Step 1: Create `src/scales/bifocal.js`

Core bifocal transform module with:

```javascript
// Key functions:
export function bifocalTransform(t, state)     // [0,1] time -> [0,1] screen
export function bifocalInverse(s, state)       // [0,1] screen -> [0,1] time
export function computeLayoutWidths(state)     // Calculate region widths
export function updateFocusRegion(state, start, end)  // Update with clamping
export function createBifocalXScale(params)    // Compatible with xScaleLens interface
```

**Bifocal state structure:**
```javascript
let bifocalState = {
  focusStart: 0.35,      // Normalized left edge [0,1]
  focusEnd: 0.65,        // Normalized right edge [0,1]
  compressionRatio: 3.0, // Context compression (slider: 1-10)
  leftContextWidth: 0.15,   // Computed screen width
  focusWidth: 0.50,         // Computed screen width
  rightContextWidth: 0.35   // Computed screen width
};
```

### Step 2: Create `src/ui/bifocal-handles.js`

SVG drag handles for focus region manipulation:
- Left/right resize handles (ew-resize cursor)
- Center grab region (move entire focus)
- Boundary indicator lines
- D3 drag behaviors with proper clamping

### Step 3: Modify `src/scales/distortion.js`

Update `createLensXScale()` (lines 48-87) to check bifocal first:

```javascript
export function createLensXScale(params) {
  const { getBifocalEnabled, getBifocalState, /* existing params */ } = params;

  return (timestamp) => {
    // NEW: Bifocal takes priority
    if (getBifocalEnabled && getBifocalEnabled()) {
      const normalized = (timestamp - tsMin) / (tsMax - tsMin);
      const position = bifocalTransform(normalized, getBifocalState());
      return minX + position * totalWidth;
    }

    // Existing fisheye/lens logic unchanged...
  };
}
```

### Step 4: Modify `attack-network.js`

**Replace state variables (lines 303-318):**
```javascript
// Remove: isLensing, lensingMul, lensCenter, horizontalFisheyeScale
// Add: bifocalEnabled, bifocalState
```

**Update scale creation (lines 1172-1185):**
```javascript
const xScaleLens = createLensXScale({
  // ... existing params ...
  getBifocalEnabled: () => bifocalEnabled,
  getBifocalState: () => bifocalState
});
```

**Replace `updateLensVisualization()` with `updateBifocalVisualization()`:**
- Same transition logic for arcs, rows, gradients
- Add call to update handle positions

**Add keyboard navigation:**
- Arrow left/right: move focus region
- Arrow up/down: expand/contract focus
- Shift+B: toggle bifocal mode

### Step 5: Modify `attack-network.html` (lines 36-48)

```html
<!-- Replace fisheye button -->
<button id="bifocalToggle" title="Toggle bifocal display (Shift+B)">
  Bifocal View
</button>

<!-- Update slider -->
<label>Compression:</label>
<input type="range" id="compressionSlider" min="1" max="10" value="3">
<span id="compressionValue">3x</span>
```

---

## Verification

1. **Monotonicity test**: Verify `t1 < t2` implies `transform(t1) < transform(t2)`
2. **Inverse test**: Verify `bifocalInverse(bifocalTransform(t)) === t`
3. **Visual checks**:
   - Arcs render correctly across all three regions
   - Drag handles resize/move focus region
   - Keyboard navigation works
4. **Edge cases**: Focus at start/end, very narrow/wide focus

---

## Migration Notes

- Keep `xScaleLens` function name for minimal rendering changes
- All existing `xScaleLens(d.minute)` calls continue to work
- Fisheye code can be removed after bifocal is stable
