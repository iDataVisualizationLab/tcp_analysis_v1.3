/**
 * D3 Fisheye Plugin for D3 v7
 * Provides both circular (radial) and Cartesian (scale-based) fisheye distortion
 * Based on the classic D3 fisheye plugin by Mike Bostock
 * Adapted for D3 v7 and ES6 modules
 * 
 * Note: D3 is expected to be available globally (loaded via script tag)
 */

// D3 is loaded globally via script tag, so we use it directly
// No import needed - d3 is available in global scope

/**
 * Creates a fisheye scale that wraps a D3 scale with fisheye distortion
 * This is the Cartesian distortion approach - applies distortion to a scale
 * @param {Function} scale - A D3 scale function (e.g., d3.scaleLinear())
 * @param {number} distortion - Distortion factor (default: 3)
 * @param {number} focus - Focus point in the scale's range (default: 0)
 * @returns {Function} A fisheye-distorted scale function
 */
export function fisheyeScale(scale, distortion = 3, focus = 0) {
  const d = distortion;
  let a = focus;

  function fisheye(_) {
    const x = scale(_);
    const range = d3.extent(scale.range());
    const min = range[0];
    const max = range[1];
    const left = x < a;
    const m = left ? a - min : max - a;
    
    if (m === 0) {
      return x; // No distortion if focus is at edge
    }
    
    // Apply fisheye distortion formula
    const result = (left ? -1 : 1) * m * (d + 1) / (d + (m / Math.abs(x - a))) + a;
    return result;
  }

  fisheye.distortion = function(_) {
    if (!arguments.length) return d;
    // Note: distortion is immutable in this implementation
    // To change distortion, create a new fisheye scale
    return fisheye;
  };

  fisheye.focus = function(_) {
    if (!arguments.length) return a;
    a = +_;
    return fisheye;
  };

  fisheye.copy = function() {
    return fisheyeScale(scale.copy(), d, a);
  };

  // Delegate scale methods
  fisheye.domain = function(_) {
    if (!arguments.length) return scale.domain();
    scale.domain(_);
    return fisheye;
  };

  fisheye.range = function(_) {
    if (!arguments.length) return scale.range();
    scale.range(_);
    return fisheye;
  };

  fisheye.nice = function() {
    scale.nice();
    return fisheye;
  };

  fisheye.ticks = function() {
    return scale.ticks.apply(scale, arguments);
  };

  fisheye.tickFormat = function() {
    return scale.tickFormat.apply(scale, arguments);
  };

  return fisheye;
}

/**
 * Creates a circular (radial) fisheye distortion
 * @param {Object} options - Configuration options
 * @param {number} options.radius - Radius of the distortion effect (default: 200)
 * @param {number} options.distortion - Distortion factor (default: 2)
 * @param {Array<number>} options.focus - Focus point [x, y] (default: [0, 0])
 * @returns {Function} Fisheye distortion function that takes {x, y} and returns {x, y, z}
 */
export function fisheyeCircular(options = {}) {
  const {
    radius = 200,
    distortion = 2,
    focus = [0, 0]
  } = options;

  let k0, k1;
  let currentRadius = radius;
  let currentDistortion = distortion;
  let currentFocus = focus;

  function rescale() {
    k0 = Math.exp(currentDistortion);
    k0 = k0 / (k0 - 1) * currentRadius;
    k1 = currentDistortion / currentRadius;
    return fisheye;
  }

  function fisheye(d) {
    const dx = d.x - currentFocus[0];
    const dy = d.y - currentFocus[1];
    const dd = Math.sqrt(dx * dx + dy * dy);
    
    if (!dd || dd >= currentRadius) {
      return { x: d.x, y: d.y, z: 1 };
    }
    
    const k = k0 * (1 - Math.exp(-dd * k1)) / dd * 0.75 + 0.25;
    return {
      x: currentFocus[0] + dx * k,
      y: currentFocus[1] + dy * k,
      z: Math.min(k, 10)
    };
  }

  fisheye.radius = function(_) {
    if (!arguments.length) return currentRadius;
    currentRadius = +_;
    return rescale();
  };

  fisheye.distortion = function(_) {
    if (!arguments.length) return currentDistortion;
    currentDistortion = +_;
    return rescale();
  };

  fisheye.focus = function(_) {
    if (!arguments.length) return currentFocus;
    currentFocus = _;
    return fisheye;
  };

  return rescale();
}

/**
 * Creates Cartesian fisheye scales for both X and Y axes
 * This is the recommended approach for scatterplots and time series
 * @param {Object} params - Configuration parameters
 * @param {Function} params.xScale - D3 scale for X axis
 * @param {Function} params.yScale - D3 scale for Y axis
 * @param {number} params.distortion - Distortion factor (default: 3)
 * @returns {Object} Object with fisheyeX and fisheyeY scales
 */
export function createCartesianFisheye(params) {
  const {
    xScale,
    yScale,
    distortion = 3
  } = params;

  const fisheyeX = fisheyeScale(xScale, distortion, 0);
  const fisheyeY = fisheyeScale(yScale, distortion, 0);

  return {
    fisheyeX,
    fisheyeY,
    // Convenience method to update both focus points
    focus: function(x, y) {
      if (x !== undefined) fisheyeX.focus(x);
      if (y !== undefined) fisheyeY.focus(y);
      return this;
    },
    // Convenience method to update distortion (creates new scales)
    distortion: function(d) {
      if (!arguments.length) return distortion;
      // Note: To change distortion, you need to recreate the scales
      return this;
    }
  };
}

// Export as default object for convenience
export default {
  scale: fisheyeScale,
  circular: fisheyeCircular,
  cartesian: createCartesianFisheye
};

