// src/layout/forceSimulation.js
// D3 force simulation setup and helpers

/**
 * Create force simulation for node layout.
 * @param {Object} d3 - D3 library
 * @param {Object[]} nodes - Nodes with 'id' property
 * @param {Object[]} links - Links with source/target/value
 * @param {Object} options - Simulation parameters
 * @returns {d3.Simulation}
 */
export function createForceSimulation(d3, nodes, links, options = {}) {
  const {
    chargeStrength = -12,
    linkDistance = 0,
    linkStrength = 1.0,
    xStrength = 0.01,
    alpha = 0.05,
    alphaDecay = 0.02,
    velocityDecay = 0.1,
  } = options;
  
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).strength(linkStrength).distance(linkDistance))
    .force('charge', d3.forceManyBody().strength(chargeStrength))
    .force('x', d3.forceX(0).strength(xStrength))
    .alpha(alpha)
    .alphaDecay(alphaDecay)
    .velocityDecay(velocityDecay)
    .stop();
  
  // Initialize positions deterministically
  nodes.forEach((n, i) => {
    if (n.x === undefined) n.x = 0;
    if (n.y === undefined) n.y = 0;
    if (n.vx === undefined) n.vx = 0;
    if (n.vy === undefined) n.vy = 0;
  });
  
  return sim;
}

/**
 * Run simulation until energy converges (async, yields to browser every yieldInterval iterations).
 * @param {d3.Simulation} sim
 * @param {number} maxIterations
 * @param {number} threshold
 * @param {number} yieldInterval - Yield to browser every N iterations
 * @returns {Promise<number>} - Iterations run
 */
export async function runUntilConverged(sim, maxIterations = 300, threshold = 0.001, yieldInterval = 50) {
  let prevEnergy = Infinity;
  let stableCount = 0;

  for (let i = 0; i < maxIterations; i++) {
    sim.tick();

    const energy = sim.nodes().reduce((sum, n) =>
      sum + (n.vx * n.vx + n.vy * n.vy), 0);

    if (Math.abs(prevEnergy - energy) < threshold) {
      stableCount++;
      if (stableCount >= 5) {
        console.log(`Converged after ${i + 1} iterations`);
        return i + 1;
      }
    } else {
      stableCount = 0;
    }
    prevEnergy = energy;

    // Yield to browser to keep UI responsive
    if ((i + 1) % yieldInterval === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  console.log(`Max iterations (${maxIterations}) reached`);
  return maxIterations;
}

/**
 * Create component separation force.
 * @param {Map} ipToComponent - Map of IP to component index
 * @param {Object[]} simNodes - Simulation nodes
 * @param {Object} params - Force parameters
 * @returns {Function} - Force function for d3
 */
export function createComponentSeparationForce(ipToComponent, simNodes, params = {}) {
  const { separationStrength = 1.2, minDistance = 80 } = params;
  
  return (alpha) => {
    // Compute component centroids
    const centroids = new Map();
    const counts = new Map();
    
    simNodes.forEach(n => {
      const compIdx = ipToComponent.get(n.id) || -1;
      if (!centroids.has(compIdx)) {
        centroids.set(compIdx, { x: 0, y: 0 });
        counts.set(compIdx, 0);
      }
      const c = centroids.get(compIdx);
      c.x += n.x || 0;
      c.y += n.y || 0;
      counts.set(compIdx, counts.get(compIdx) + 1);
    });
    
    // Normalize
    centroids.forEach((c, idx) => {
      const count = counts.get(idx);
      if (count > 0) { c.x /= count; c.y /= count; }
    });
    
    // Apply separation between centroids
    const compIndices = Array.from(centroids.keys());
    for (let i = 0; i < compIndices.length; i++) {
      for (let j = i + 1; j < compIndices.length; j++) {
        const compA = compIndices[i];
        const compB = compIndices[j];
        const cA = centroids.get(compA);
        const cB = centroids.get(compB);
        
        const dx = cB.x - cA.x;
        const dy = cB.y - cA.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        
        if (dist < minDistance * 2) {
          const force = (minDistance * 2 - dist) / dist * separationStrength * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force * 3.0; // Stronger vertical separation
          
          simNodes.forEach(n => {
            const comp = ipToComponent.get(n.id) || -1;
            const countA = counts.get(compA) || 1;
            const countB = counts.get(compB) || 1;
            if (comp === compA) {
              n.vx = (n.vx || 0) - fx / countA;
              n.vy = (n.vy || 0) - fy / countA;
            } else if (comp === compB) {
              n.vx = (n.vx || 0) + fx / countB;
              n.vy = (n.vy || 0) + fy / countB;
            }
          });
        }
      }
    }
    
    // Also apply individual node-level separation for nodes near component boundaries
    for (let i = 0; i < simNodes.length; i++) {
      const nodeA = simNodes[i];
      const compA = ipToComponent.get(nodeA.id) || -1;
      
      for (let j = i + 1; j < simNodes.length; j++) {
        const nodeB = simNodes[j];
        const compB = ipToComponent.get(nodeB.id) || -1;
        
        // Only apply separation force between nodes in different components
        if (compA !== compB) {
          const dx = (nodeB.x || 0) - (nodeA.x || 0);
          const dy = (nodeB.y || 0) - (nodeA.y || 0);
          const distanceSquared = dx * dx + dy * dy;
          const distance = Math.sqrt(distanceSquared) || 1;
          
          // Stronger repulsion for nodes in different components
          if (distance < minDistance * 1.5 && distance > 0) {
            const force = (minDistance * 1.5 - distance) / distance * separationStrength * alpha * 0.5;
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;
            
            // Apply stronger vertical separation
            const verticalBoost = 4.0;
            nodeA.vx = (nodeA.vx || 0) - fx;
            nodeA.vy = (nodeA.vy || 0) - fy * verticalBoost;
            nodeB.vx = (nodeB.vx || 0) + fx;
            nodeB.vy = (nodeB.vy || 0) + fy * verticalBoost;
          }
        }
      }
    }
  };
}

/**
 * Create a weaker component separation force for stage 2.
 * @param {Map} ipToComponent - Map of IP to component index
 * @param {Object[]} simNodes - Simulation nodes
 * @param {Object} params - Force parameters
 * @returns {Function} - Force function for d3
 */
export function createWeakComponentSeparationForce(ipToComponent, simNodes, params = {}) {
  const { separationStrength = 0.3, minDistance = 50 } = params;
  
  return (alpha) => {
    for (let i = 0; i < simNodes.length; i++) {
      const nodeA = simNodes[i];
      const compA = ipToComponent.get(nodeA.id) || -1;
      
      for (let j = i + 1; j < simNodes.length; j++) {
        const nodeB = simNodes[j];
        const compB = ipToComponent.get(nodeB.id) || -1;
        
        if (compA !== compB) {
          const dx = (nodeB.x || 0) - (nodeA.x || 0);
          const dy = (nodeB.y || 0) - (nodeA.y || 0);
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          
          if (distance < minDistance && distance > 0) {
            const force = (minDistance - distance) / distance * separationStrength * alpha;
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;
            
            const verticalBoost = 2.0;
            nodeA.vx = (nodeA.vx || 0) - fx;
            nodeA.vy = (nodeA.vy || 0) - fy * verticalBoost;
            nodeB.vx = (nodeB.vx || 0) + fx;
            nodeB.vy = (nodeB.vy || 0) + fy * verticalBoost;
          }
        }
      }
    }
  };
}

/**
 * Create component cohesion force - keeps nodes within their component together.
 * @param {Map} ipToComponent - Map of IP to component index
 * @param {Object[]} simNodes - Simulation nodes
 * @param {Object} params - Force parameters
 * @returns {Function} - Force function for d3
 */
export function createComponentCohesionForce(ipToComponent, simNodes, params = {}) {
  const { cohesionStrength = 0.3 } = params;
  
  return (alpha) => {
    // Compute component centroids
    const centroids = new Map();
    const counts = new Map();
    
    simNodes.forEach(n => {
      const compIdx = ipToComponent.get(n.id) || -1;
      if (!centroids.has(compIdx)) {
        centroids.set(compIdx, { x: 0, y: 0 });
        counts.set(compIdx, 0);
      }
      const c = centroids.get(compIdx);
      c.x += n.x || 0;
      c.y += n.y || 0;
      counts.set(compIdx, counts.get(compIdx) + 1);
    });
    
    // Normalize centroids
    centroids.forEach((c, idx) => {
      const count = counts.get(idx);
      if (count > 0) { c.x /= count; c.y /= count; }
    });
    
    // Attract nodes to their component centroid
    simNodes.forEach(n => {
      const compIdx = ipToComponent.get(n.id) || -1;
      const centroid = centroids.get(compIdx);
      if (centroid) {
        const dx = centroid.x - (n.x || 0);
        const dy = centroid.y - (n.y || 0);
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        
        // Only apply if node is far from centroid (to allow internal structure)
        if (distance > 20) {
          const force = Math.min(distance / 50, 1) * cohesionStrength * alpha;
          n.vx = (n.vx || 0) + (dx / distance) * force;
          n.vy = (n.vy || 0) + (dy / distance) * force;
        }
      }
    });
  };
}

/**
 * Create hub centering force - pulls highest-degree IP to component center.
 * @param {Map} componentHubIps - Map of component index to hub IP
 * @param {Map} componentCenters - Map of component index to target Y position
 * @param {Object[]} simNodes - Simulation nodes
 * @param {Object} params - Force parameters
 * @returns {Function} - Force function for d3
 */
export function createHubCenteringForce(componentHubIps, componentCenters, simNodes, params = {}) {
  const { hubStrength = 2.0 } = params;
  
  return (alpha) => {
    componentHubIps.forEach((hubIp, compIdx) => {
      const hubNode = simNodes.find(n => n.id === hubIp);
      if (!hubNode) return;
      
      const targetY = componentCenters.get(compIdx);
      if (targetY === undefined) return;
      
      const currentY = hubNode.y || targetY;
      const dy = targetY - currentY;
      const distance = Math.abs(dy);
      
      if (distance > 0.1) {
        const force = hubStrength * alpha * Math.min(distance / 50, 1);
        hubNode.vy = (hubNode.vy || 0) + (dy > 0 ? force : -force);
      }
    });
  };
}

/**
 * Create Y positioning force for components.
 * @param {Object} d3 - D3 library
 * @param {Map} ipToComponent - Map of IP to component index
 * @param {Map} componentCenters - Map of component index to Y position
 * @param {number} defaultY - Default Y position
 * @returns {d3.ForceY}
 */
export function createComponentYForce(d3, ipToComponent, componentCenters, defaultY) {
  return d3.forceY()
    .y(n => {
      const compIdx = ipToComponent.get(n.id) || 0;
      return componentCenters.get(compIdx) || defaultY;
    })
    .strength(1.0);
}

/**
 * Initialize node positions by component.
 * @param {Object[]} nodes - Simulation nodes
 * @param {Map} ipToComponent - Map of IP to component index
 * @param {Map} componentCenters - Map of component index to Y position
 * @param {number} centerX - X center position
 * @param {Map} ipDegree - Map of IP to degree (for sorting)
 * @param {number} componentSpacing - Spacing between components
 */
export function initializeNodePositions(nodes, ipToComponent, componentCenters, centerX, ipDegree, componentSpacing = 30) {
  // Group nodes by component
  const byComponent = new Map();
  nodes.forEach(n => {
    const comp = ipToComponent.get(n.id) || 0;
    if (!byComponent.has(comp)) byComponent.set(comp, []);
    byComponent.get(comp).push(n);
  });
  
  // Sort nodes within each component by degree (descending), then by IP string
  byComponent.forEach((nodeList, compIdx) => {
    nodeList.sort((a, b) => {
      const degreeA = ipDegree.get(a.id) || 0;
      const degreeB = ipDegree.get(b.id) || 0;
      if (degreeB !== degreeA) return degreeB - degreeA;
      return a.id.localeCompare(b.id);
    });
  });
  
  // Position each component's nodes
  byComponent.forEach((nodeList, compIdx) => {
    const targetY = componentCenters.get(compIdx) || 400;
    const spread = Math.min(componentSpacing * 0.3, 30);
    const step = nodeList.length > 1 ? spread / (nodeList.length - 1) : 0;
    
    nodeList.forEach((n, idx) => {
      n.x = centerX;
      if (nodeList.length === 1) {
        n.y = targetY;
      } else {
        const offset = (idx - (nodeList.length - 1) / 2) * step;
        n.y = targetY + offset;
      }
      n.vx = 0;
      n.vy = 0;
    });
  });
}

/**
 * Calculate component centers based on vertical spacing.
 * @param {Array} components - Array of component IP arrays
 * @param {number} marginTop - Top margin
 * @param {number} innerHeight - Available height
 * @returns {Map} - Map of component index to Y center position
 */
export function calculateComponentCenters(components, marginTop, innerHeight) {
  const componentCenters = new Map();
  const componentSpacing = innerHeight / components.length;
  
  components.forEach((comp, compIdx) => {
    const componentStart = marginTop + compIdx * componentSpacing;
    const componentCenter = componentStart + componentSpacing / 2;
    componentCenters.set(compIdx, componentCenter);
  });
  
  return componentCenters;
}

/**
 * Find hub IPs (highest degree) for each component.
 * @param {Array} components - Array of component IP arrays
 * @param {Map} ipDegree - Map of IP to degree
 * @returns {Map} - Map of component index to hub IP
 */
export function findComponentHubIps(components, ipDegree) {
  const componentHubIps = new Map();
  
  components.forEach((comp, compIdx) => {
    let maxDegree = -1;
    let hubIp = null;
    comp.forEach(ip => {
      const degree = ipDegree.get(ip) || 0;
      if (degree > maxDegree) {
        maxDegree = degree;
        hubIp = ip;
      }
    });
    if (hubIp) {
      componentHubIps.set(compIdx, hubIp);
    }
  });
  
  return componentHubIps;
}

/**
 * Calculate IP degrees from links.
 * @param {Object[]} links - Links with sourceNode and targetNode
 * @returns {Map} - Map of IP to degree (connection count)
 */
export function calculateIpDegrees(links) {
  const ipDegree = new Map();
  links.forEach(l => {
    const srcName = l.sourceNode?.name || l.source;
    const tgtName = l.targetNode?.name || l.target;
    ipDegree.set(srcName, (ipDegree.get(srcName) || 0) + 1);
    ipDegree.set(tgtName, (ipDegree.get(tgtName) || 0) + 1);
  });
  return ipDegree;
}

/**
 * Calculate total connection strength (weighted by link counts) for each IP.
 * @param {Object[]} links - Links with count property
 * @returns {Map} - Map of IP to total connection strength
 */
export function calculateConnectionStrength(links) {
  const strength = new Map();
  links.forEach(l => {
    const srcName = l.sourceNode?.name || l.source;
    const tgtName = l.targetNode?.name || l.target;
    const weight = l.count || 1;
    strength.set(srcName, (strength.get(srcName) || 0) + weight);
    strength.set(tgtName, (strength.get(tgtName) || 0) + weight);
  });
  return strength;
}

/**
 * Create mutual hub attraction force.
 * Creates mutual attraction between IPs with high connection counts,
 * pulling them together into tight clusters. This creates a natural
 * "core-periphery" structure where hubs cluster together.
 *
 * @param {Map} ipToComponent - Map of IP to component index
 * @param {Map} connectionStrength - Map of IP to total connection strength
 * @param {Object[]} simNodes - Simulation nodes
 * @param {Object} params - Force parameters
 * @returns {Function} - Force function for d3
 */
export function createMutualHubAttractionForce(ipToComponent, connectionStrength, simNodes, params = {}) {
  const { attractionStrength = 0.8, hubThreshold = 0.3 } = params;

  // Normalize connection strengths per component (0-1 scale)
  const normalizedStrength = new Map();
  const componentMaxStrength = new Map();

  // Find max strength per component
  simNodes.forEach(n => {
    const compIdx = ipToComponent.get(n.id) || 0;
    const strength = connectionStrength.get(n.id) || 0;
    const currentMax = componentMaxStrength.get(compIdx) || 0;
    componentMaxStrength.set(compIdx, Math.max(currentMax, strength));
  });

  // Normalize strengths (0-1 within each component)
  simNodes.forEach(n => {
    const compIdx = ipToComponent.get(n.id) || 0;
    const strength = connectionStrength.get(n.id) || 0;
    const maxStrength = componentMaxStrength.get(compIdx) || 1;
    normalizedStrength.set(n.id, maxStrength > 0 ? strength / maxStrength : 0);
  });

  // Identify hub nodes (above threshold in normalized strength)
  const isHub = new Map();
  simNodes.forEach(n => {
    const normStr = normalizedStrength.get(n.id) || 0;
    isHub.set(n.id, normStr >= hubThreshold);
  });

  return (alpha) => {
    // Create mutual attraction between hub nodes in the same component
    for (let i = 0; i < simNodes.length; i++) {
      const nodeA = simNodes[i];
      const isHubA = isHub.get(nodeA.id);
      if (!isHubA) continue; // Skip non-hub nodes

      const compA = ipToComponent.get(nodeA.id) || 0;
      const strengthA = normalizedStrength.get(nodeA.id) || 0;

      for (let j = i + 1; j < simNodes.length; j++) {
        const nodeB = simNodes[j];
        const isHubB = isHub.get(nodeB.id);
        if (!isHubB) continue; // Skip non-hub nodes

        const compB = ipToComponent.get(nodeB.id) || 0;

        // Only attract hubs within the same component
        if (compA !== compB) continue;

        const strengthB = normalizedStrength.get(nodeB.id) || 0;

        // Calculate attraction force
        const dx = (nodeB.x || 0) - (nodeA.x || 0);
        const dy = (nodeB.y || 0) - (nodeA.y || 0);
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;

        // Attraction strength proportional to product of connection strengths
        // Strong hubs attract each other more strongly
        const combinedStrength = strengthA * strengthB;
        const force = combinedStrength * attractionStrength * alpha * Math.min(distance / 50, 1);

        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        // Apply attraction (pull nodes toward each other)
        nodeA.vx = (nodeA.vx || 0) + fx;
        nodeA.vy = (nodeA.vy || 0) + fy;
        nodeB.vx = (nodeB.vx || 0) - fx;
        nodeB.vy = (nodeB.vy || 0) - fy;
      }
    }
  };
}
