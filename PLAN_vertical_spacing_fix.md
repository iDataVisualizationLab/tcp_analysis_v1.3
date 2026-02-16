# Plan: Dynamic SVG Height with Minimum IP Spacing

## Problem
With 100+ IPs in fixed INNER_HEIGHT=780, vertical step shrinks to ~5px. Labels (8px font) need ~12-14px and overlap badly.

## Solution
Enforce a minimum vertical spacing per IP. When the required height exceeds INNER_HEIGHT, expand the SVG. The `#chart-container` already has `overflow: auto` so scrolling works automatically.

## Constant
`MIN_IP_SPACING = 14` (px) — added to `src/config/constants.js`

## Changes

### 1. `src/config/constants.js`
Add `MIN_IP_SPACING = 14` export.

### 2. `attack-network.js` — import line (~line 1)
Add `MIN_IP_SPACING` to the constants import.

### 3. `attack-network.js` — final positioning (~line 2461)
Current:
```js
const step = Math.min((INNER_HEIGHT - 25) / (sortedIps.length + 1), 15);
```
Change to:
```js
const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (sortedIps.length + 1), 15));
const dynamicInnerHeight = Math.max(INNER_HEIGHT, 12 + sortedIps.length * step + 25);
```
Then update SVG height:
```js
const dynamicHeight = MARGIN.top + dynamicInnerHeight + MARGIN.bottom;
svg.attr('height', dynamicHeight);
```

### 4. `attack-network.js` — `compactIPPositions` (~line 3004)

**Single component path (line 3019):**
```js
// Current:
const step = Math.min((INNER_HEIGHT - 25) / (ipArray.length + 1), 15);
// Change to:
const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (ipArray.length + 1), 15));
```

**Multi-component path (line 3074-3077):**
Change absolute minimum from `8` to `MIN_IP_SPACING`:
```js
const ipStep = Math.max(
  Math.min(spaceForIPs / (numIPs + 1), minIPSpacing),
  MIN_IP_SPACING  // was 8
);
```

### 5. `attack-network.js` — brush extent (~line 1404)
The brush extent uses `MARGIN.top + INNER_HEIGHT`. Since `setupDragToBrush` runs before final positioning computes `dynamicInnerHeight`, store it at module scope and update brush extent after height is known. Alternatively, reconfigure brush extent after final height is calculated:
```js
if (brushGroup && brush) {
  brush.extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, dynamicHeight]]);
  brushGroup.call(brush);
}
```

### 6. `attack-network.js` — bifocal handle chartHeight (~line 2931)
Pass `dynamicHeight` instead of `height + MARGIN.top + MARGIN.bottom` to `createBifocalHandles`.

## Unchanged
- Force simulation and IP order
- Arc rendering
- Bifocal/lens behavior
- Label font size (8px)
- Row line rendering

## Verification
1. `python -m http.server 8000`, open `attack-network.html`
2. Load CSV with 100+ IPs — labels readable, container scrolls
3. Load CSV with <50 IPs — stays compact, no unnecessary expansion
4. Brush selection works across full dynamic height
5. Bifocal handles span full chart height
6. Window resize re-renders correctly
