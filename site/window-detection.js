// Find rectangles with contrast along all four sides. These are review suggestions.
export function frameRectangles(pixels, size, evidence) {
  const gray = (x, y) => {
    const i = (y * size + x) * 4;
    return .30 * pixels[i] + .59 * pixels[i+1] + .11 * pixels[i+2];
  };
  const peaks = (horizontal, fixed, from, to) => {
    let score = 0;
    for (let i = from; i < to; i += 2)
      score += horizontal ? Math.abs(gray(i, fixed+1)-gray(i, fixed-1))
        : Math.abs(gray(fixed+1, i)-gray(fixed-1, i));
    return score / Math.ceil((to-from)/2);
  };
  const edges = horizontal => Array.from({length: size-4}, (_, i) => i+2)
    .map(i => [i, peaks(horizontal, i, 2, size-2)])
    .sort((a, b) => b[1]-a[1]).slice(0, 14).map(([i]) => i).sort((a,b) => a-b);
  const xs = edges(false), ys = edges(true);
  const found = [];
  for (const x of xs) for (const right of xs) {
    if (right-x < size*.12 || right-x > size*.94) continue;
    for (const y of ys) for (const top of ys) {
      if (top-y < size*.17 || top-y > size*.88) continue;
      const score = Math.min(peaks(true,y,x,right), peaks(true,top,x,right),
        peaks(false,x,y,top), peaks(false,right,y,top));
      if (score >= 19) found.push({x,y,right,top,score});
    }
  }
  const best = [];
  const qualified = evidence ? found.flatMap(box => {
    const weight = evidence(box);
    return weight === null ? [] : [{...box, score: weight}];
  }) : found;
  for (const box of qualified.sort((a,b) => b.score-a.score)) {
    if (best.some(other => Math.min(other.right,box.right)-Math.max(other.x,box.x) > 0 &&
        Math.min(other.top,box.top)-Math.max(other.y,box.y) > 0)) continue;
    best.push(box);
    if (best.length === 3) break;
  }
  return best;
}

// A scan gap is useful evidence only when solid mesh surrounds it. Missing
// surface alone can also be a capture defect, so these remain suggestions.
export function openingEvidence(mask, size, box) {
  const {x, y, right, top} = box;
  const coverage = (left, bottom, endX, endY) => {
    let solid = 0, total = 0;
    for (let row = Math.max(0, bottom); row < Math.min(size, endY); row++) {
      for (let col = Math.max(0, left); col < Math.min(size, endX); col++) {
        solid += mask[(row * size + col) * 4] > 127;
        total++;
      }
    }
    return total ? solid / total : 0;
  };
  if (x < 3 || right > size - 3 || y < 4) return null;
  const inset = 3;
  const interior = coverage(x+inset, y+inset, right-inset, top-inset);
  const borders = [
    coverage(x+inset, y-5, right-inset, y-1),
    coverage(x+inset, top+1, right-inset, top+5),
    coverage(x-5, y+inset, x-1, top-inset),
    coverage(right+1, y+inset, right+5, top-inset),
  ];
  const [sill, lintel, leftJamb, rightJamb] = borders;
  if (interior > .32 || sill < .55 || leftJamb < .52 || rightJamb < .52) return null;
  if (lintel < .45 && top < size - 9) return null;
  return 1 - interior + Math.min(sill, leftJamb, rightJamb) + .2 * lintel;
}

export function darkPaneEvidence(pixels, mask, size, {x, y, right, top}) {
  function sample(left, bottom, endX, endY) {
    let count = 0, dark = 0, brightSurface = 0;
    for (let row = Math.max(0, bottom); row < Math.min(size, endY); row++) {
      for (let col = Math.max(0, left); col < Math.min(size, endX); col++) {
        const offset = (row * size + col) * 4;
        const luminance = .30 * pixels[offset] + .59 * pixels[offset+1] + .11 * pixels[offset+2];
        count++;
        if (luminance <= 42) dark++;
        if (mask[offset] > 127 && luminance >= 68) brightSurface++;
      }
    }
    return {dark: count ? dark / count : 0, brightSurface: count ? brightSurface / count : 0};
  }
  if (x < 3 || right > size - 3 || y < 4) return null;
  const interior = sample(x+3, y+3, right-3, top-3);
  const sill = sample(x+3, y-6, right-3, y-1).brightSurface;
  const lintel = sample(x+3, top+1, right-3, top+6).brightSurface;
  const left = sample(x-5, y+3, x-1, top-3).brightSurface;
  const rightSide = sample(right+1, y+3, right+5, top-3).brightSurface;
  if (interior.dark < .76 || sill < .48 || left < .42 || rightSide < .42) return null;
  if (lintel < .40 && top < size - 9) return null;
  return interior.dark + Math.min(sill, left, rightSide) + .2 * lintel;
}

export function adjacentPanes(pixels, mask, size, seeds, minWidth) {
  const luminance = (x, y) => {
    const i = (y * size + x) * 4;
    return .30 * pixels[i] + .59 * pixels[i+1] + .11 * pixels[i+2];
  };
  const panes = [];
  for (const seed of seeds) {
    const {y, top} = seed;
    const jambs = Array.from({length: size - 4}, (_, i) => i + 2).map(x => {
      let edge = 0, continuous = 0;
      for (let row = y + 4; row < top - 4; row++) {
        const contrast = Math.abs(luminance(x - 2, row) - luminance(x + 2, row));
        edge += contrast;
        continuous += contrast >= 17;
      }
      const samples = Math.max(1, top - y - 8);
      return [x, edge / samples, continuous / samples];
    }).filter(([, score, continuity]) => score >= 12 && continuity >= .25);
    for (const direction of [-1, 1]) {
      let boundary = direction < 0 ? seed.x : seed.right;
      for (let step = 0; step < 5; step++) {
        const choices = [];
        for (const [outer, edge, continuity] of jambs) {
          const width = (outer - boundary) * direction;
          if (width < minWidth || width > (seed.right - seed.x) * 1.9) continue;
          const inset = Math.min(3, Math.floor(minWidth / 3));
          const box = direction < 0
            ? {x: outer, right: boundary - inset, y, top}
            : {x: boundary + inset, right: outer, y, top};
          if (box.right - box.x < minWidth * .75) continue;
          let count = 0, gap = 0, colored = 0, sill = 0, header = 0;
          for (let x = box.x + 2; x < box.right - 2; x++) {
            // The sill and header can step or drift across adjacent panes.
            const horizontalEdge = (height, threshold) => [-3, 0, 3].some(offset => {
              const row = height + offset;
              return Math.abs(luminance(x, Math.max(0, row - 2)) -
                luminance(x, Math.min(size - 1, row + 2))) >= threshold;
            });
            sill += horizontalEdge(y, 15);
            header += horizontalEdge(top, 12);
            for (let row = y + 4; row < top - 4; row += 2) {
              const i = (row * size + x) * 4;
              gap += mask[i] < 128 || luminance(x, row) < 40;
              colored += Math.max(pixels[i], pixels[i+1], pixels[i+2]) -
                Math.min(pixels[i], pixels[i+1], pixels[i+2]) >= 24;
              count++;
            }
          }
          const columns = Math.max(1, box.right - box.x - 4);
          if (!count || (gap / count < .46 && colored / count < .40) ||
              sill / columns < .32 || (top < size - 8 && header / columns < .19)) continue;
          // Favor a sustained divider at the end of a full sill span over
          // short texture edges inside the pane.
          const score = (sill + header) / columns + Math.max(gap, colored) / count
            + Math.min(edge / 120, .4) + continuity * .45
            + Math.min(width / (seed.right - seed.x), 1) * .85;
          choices.push({...box, score, outer});
        }
        choices.sort((a, b) => b.score - a.score);
        const chosen = choices[0];
        if (!chosen) break;
        panes.push(chosen);
        boundary = chosen.outer;
      }
    }
  }
  return panes;
}

function luminanceAt(pixels, size, x, y) {
  const i = (y * size + x) * 4;
  return .30 * pixels[i] + .59 * pixels[i + 1] + .11 * pixels[i + 2];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Split one sill-to-header band into panes. A mullion is a narrow column that
// stays different from the glass on both sides for the whole band, or whose
// horizontal edge is stronger than the texture around it. Medians ignore a
// short mark inside a pane. A wide flat solid is a pier and separates panes.
export function splitWindowRow(pixels, mask, size, span, minWidth, maxDivider = 8, options = {}) {
  const trustOpening = options.trustOpening === true;
  const y = Math.max(0, span.y | 0);
  const top = Math.min(size, span.top | 0);
  const left = Math.max(1, span.x | 0);
  const right = Math.min(size - 1, span.right | 0);
  const rows = [];
  for (let row = y + 4; row < top - 4; row++) rows.push(row);
  const rejected = [];
  if (rows.length < 8 || right - left < minWidth) return {panes: [], rejected};
  const columns = [];
  for (let x = left; x < right; x++) {
    let gap = 0, dark = 0, colored = 0, bright = 0, divider = 0, mean = 0;
    const lums = [], edges = [];
    for (const row of rows) {
      const i = (row * size + x) * 4;
      const lum = .30 * pixels[i] + .59 * pixels[i + 1] + .11 * pixels[i + 2];
      mean += lum;
      lums.push(lum);
      const solid = mask[i] > 127;
      if (!solid || lum < 40) gap++;
      if (lum <= 42) dark++;
      const hi = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const lo = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (hi - lo >= 24 && lum > 42) colored++;
      if (solid && lum >= 100) bright++;
      const edge = Math.abs(luminanceAt(pixels, size, x - 1, row) -
        luminanceAt(pixels, size, Math.min(size - 1, x + 1), row));
      edges.push(edge);
      if (edge >= 20) divider++;
    }
    const n = rows.length;
    mean /= n;
    let deviation = 0;
    for (const row of rows) deviation += (luminanceAt(pixels, size, x, row) - mean) ** 2;
    deviation = Math.sqrt(deviation / n);
    const stats = {gap: gap / n, dark: dark / n, colored: colored / n,
      bright: bright / n, divider: divider / n, deviation,
      medianLum: median(lums), medianEdge: median(edges)};
    const wallLike = stats.bright >= .62 && stats.deviation < 14 && stats.colored < .2 &&
      stats.dark < .25 && stats.gap < .25;
    const glassCue = stats.dark >= .45 || stats.colored >= .28 || stats.gap >= .4 || stats.deviation >= 16;
    columns.push({x, ...stats, wallLike, glass: !wallLike && (trustOpening || glassCue)});
  }
  const runs = [];
  let run = [];
  let pending = [];
  const closeRun = () => {
    if (run.length >= minWidth) runs.push(run);
    run = [];
  };
  for (const column of columns) {
    if (column.glass) {
      if (pending.length > maxDivider) {
        closeRun();
        if (pending.length >= minWidth)
          rejected.push({x: pending[0].x, right: pending.at(-1).x + 1, y, top,
            reason: "solid column or wall"});
      } else {
        run.push(...pending);
      }
      run.push(column);
      pending = [];
    } else pending.push(column);
  }
  if (pending.length > maxDivider && pending.length >= minWidth)
    rejected.push({x: pending[0].x, right: pending.at(-1).x + 1, y, top,
      reason: "solid column or wall"});
  if (pending.length <= maxDivider) run.push(...pending);
  closeRun();
  const panes = [];
  for (const group of runs) {
    const mullions = [];
    let cluster = [];
    const close = () => {
      if (!cluster.length) return;
      const width = cluster.at(-1).x - cluster[0].x + 1;
      if (width <= maxDivider && group.some(column => column.x < cluster[0].x && column.glass) &&
          group.some(column => column.x > cluster.at(-1).x && column.glass))
        mullions.push(cluster);
      cluster = [];
    };
    const edgeMedian = median(group.map(column => column.medianEdge));
    const edgeMad = median(group.map(column => Math.abs(column.medianEdge - edgeMedian)));
    const edgeCut = edgeMedian + Math.max(14, 2.5 * edgeMad);
    const sides = column => {
      const earlier = group.filter(item => item.x <= column.x - maxDivider && item.x > column.x - maxDivider - minWidth);
      const later = group.filter(item => item.x >= column.x + maxDivider && item.x < column.x + maxDivider + minWidth);
      if (earlier.length < 3 || later.length < 3) return null;
      const left = median(earlier.map(item => item.medianLum));
      const right = median(later.map(item => item.medianLum));
      return {low: Math.min(left, right), high: Math.max(left, right),
        nearer: Math.min(Math.abs(column.medianLum - left), Math.abs(column.medianLum - right))};
    };
    for (const column of group) {
      const flank = sides(column);
      // Outside both neighbors: a bar that matches neither pane. A smooth
      // change lies between them and stays part of the glass.
      const outside = flank && (column.medianLum <= flank.low - 18 || column.medianLum >= flank.high + 18);
      const edged = flank && column.medianEdge >= edgeCut && flank.nearer >= 14;
      if (outside || edged) cluster.push(column);
      else close();
    }
    close();
    const cuts = [group[0].x, ...mullions.map(item => item[0].x), ...mullions.map(item => item.at(-1).x + 1), group.at(-1).x + 1]
      .sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const x = cuts[i], edge = cuts[i + 1];
      if (mullions.some(item => x >= item[0].x && edge <= item.at(-1).x + 1)) continue;
      const slice = group.filter(column => column.x >= x && column.x < edge && column.glass);
      if (edge - x < minWidth) {
        rejected.push({x, right: edge, y, top, reason: "narrower than a pane"});
        continue;
      }
      if (!slice.length) continue;
      const meanOf = key => slice.reduce((sum, column) => sum + column[key], 0) / slice.length;
      const dark = meanOf("dark"), colored = meanOf("colored"), gap = meanOf("gap");
      const deviation = meanOf("deviation");
      const kind = dark >= .5 ? "Dark pane" : colored >= .28 || deviation >= 18 ? "Bright glass pane"
        : trustOpening ? "Glass pane" : "Mesh opening";
      const glass = Math.max(dark, colored, gap, deviation >= 18 || trustOpening ? .4 : 0);
      const wallFraction = slice.filter(column => column.wallLike).length / slice.length;
      if (wallFraction > .5 || glass < .34) {
        rejected.push({x, right: edge, y, top, reason: wallFraction > .5 ? "solid column or wall" : "no glass between the mullions"});
        continue;
      }
      panes.push({x, right: edge, y, top, kind,
        score: glass + Math.min(meanOf("deviation") / 80, .25) + (mullions.length ? .35 : 0)});
    }
  }
  return {panes, rejected};
}

// A pane is a stretch of wall the MatterPak never reconstructed: empty in the
// occupancy mask, with scanned mesh underneath it for a sill. A solid column
// wider than a mullion separates panes. Photo color is not used here.
export function meshGapPanes(mask, size, minWidth, minHeight, maxHeight, minDivider, x0 = 0, x1 = size, yOrigin = null, metersY = null) {
  const solidAt = (x, y) => x >= 0 && y >= 0 && x < size && y < size && mask[(y * size + x) * 4] > 127;
  const columns = [];
  for (let x = x0; x < x1; x++) {
    // A few reconstructed triangles inside the glass still leave a window.
    const open = new Uint8Array(size);
    for (let y = 0; y < size; y++) open[y] = solidAt(x, y) ? 0 : 1;
    for (let y = 0; y < size;) {
      if (open[y]) { y++; continue; }
      let end = y;
      while (end < size && !open[end]) end++;
      if (y > 0 && open[y - 1] && end < size && open[end] && end - y <= 3)
        for (let row = y; row < end; row++) open[row] = 1;
      y = end;
    }
    let best = null;
    let start = -1;
    for (let y = 0; y <= size; y++) {
      const hole = y < size && open[y] === 1;
      if (hole && start < 0) start = y;
      if (!hole && start >= 0) {
        const top = y;
        const height = top - start;
        let sill = 0, samples = 0, support = 0, looked = 0;
        for (let row = start - 8; row < start; row++) {
          if (row < 0) continue;
          looked++;
          const filled = solidAt(x, row);
          support += filled;
          if (row >= start - 4) { samples++; sill += filled; }
        }
        const firmSill = samples >= 2 && sill / samples >= .6;
        const raisedOpening = looked >= 3 && support / looked >= .35 && start > 8;
        let chosen = null;
        if (height >= minHeight && height <= maxHeight && (firmSill || raisedOpening))
          chosen = {y: start, top};
        else if (metersY && yOrigin != null && height > maxHeight && top < size - 3 &&
            solidAt(x, Math.min(size - 1, top + 2))) {
          // The hole continues through the apron, but it still ends under a header.
          const bandBottom = Math.max(0, Math.round((.7 - yOrigin) / metersY));
          const bandTop = Math.min(top, Math.round((2.35 - yOrigin) / metersY));
          let openRows = 0, rows = 0;
          for (let row = bandBottom; row < bandTop; row++) { rows++; openRows += open[row]; }
          if (rows >= minHeight && bandTop - bandBottom >= minHeight && openRows / rows >= .45)
            chosen = {y: bandBottom, top: bandTop};
        }
        if (chosen && (!best || chosen.top - chosen.y > best.top - best.y)) best = chosen;
        start = -1;
      }
    }
    columns.push({x, hole: Boolean(best), y: best?.y ?? 0, top: best?.top ?? 0});
  }
  const panes = [];
  let run = [];
  let gap = 0;
  const flush = () => {
    if (run.length >= minWidth) {
      const y = Math.round(median(run.map(column => column.y)));
      const top = Math.round(median(run.map(column => column.top)));
      const right = run.at(-1).x + 1;
      panes.push({x: run[0].x, right, y, top, kind: "Mesh opening",
        score: (right - run[0].x) * (top - y), confidence: .92,
        source: "Unscanned MatterPak opening"});
    }
    run = [];
  };
  for (const column of columns) {
    if (!column.hole) {
      if (run.length) gap++;
      continue;
    }
    const aligned = !run.length || Math.min(column.top, run[0].top) - Math.max(column.y, run[0].y) >= minHeight * .5;
    if (!aligned || gap >= minDivider) flush();
    gap = 0;
    run.push(column);
  }
  flush();
  // A pane in the same row can be only partly missing. Grow from each clear
  // hole across a mullion into columns that are still mostly unscanned.
  const partialMin = Math.max(4, Math.round(minWidth * .6));
  const extras = [];
  const taken = x => panes.some(pane => x >= pane.x && x < pane.right) ||
    extras.some(pane => x >= pane.x && x < pane.right);
  const emptyFraction = (x, y, top) => {
    let hole = 0, count = 0;
    for (let row = y; row < top; row++) { count++; hole += solidAt(x, row) ? 0 : 1; }
    return count ? hole / count : 0;
  };
  for (const pane of panes) {
    for (const direction of [-1, 1]) {
      let solid = 0;
      const run = [];
      const bridge = Math.max(minDivider, minWidth);
      for (let x = direction < 0 ? pane.x - 1 : pane.right; direction < 0 ? x >= x0 : x < x1; x += direction) {
        if (taken(x)) break;
        const fraction = emptyFraction(x, pane.y, pane.top);
        let sill = 0, looked = 0;
        for (let row = Math.max(0, pane.y - 8); row < pane.y; row++) {
          looked++;
          sill += solidAt(x, row) ? 1 : 0;
        }
        const patchy = fraction >= .32 && fraction <= .9;
        const openAboveSill = fraction >= .32 && looked >= 3 && sill / looked >= .25;
        if (patchy || openAboveSill) {
          if (solid >= bridge) break;
          solid = 0;
          run.push(x);
        } else if (++solid >= bridge) break;
      }
      if (run.length < partialMin) continue;
      run.sort((a, b) => a - b);
      const right = run.at(-1) + 1;
      extras.push({x: run[0], right, y: pane.y, top: pane.top, kind: "Mesh opening",
        score: (right - run[0]) * (pane.top - pane.y), confidence: .84,
        source: "Unscanned MatterPak opening"});
    }
  }
  panes.push(...extras);
  panes.sort((a, b) => b.score - a.score);
  return {panes, rejected: []};
}

function overlapFraction(a, b) {
  const area = box => (box.right - box.x) * (box.top - box.y);
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.top, b.top) - Math.max(a.y, b.y));
  return width * height / Math.min(area(a), area(b));
}

export function mergePaneViews(candidates) {
  const groups = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    const matching = groups.find(({best}) => {
      const width = Math.max(best.right - best.x, candidate.right - candidate.x);
      const centerDistance = Math.abs(best.x + best.right - candidate.x - candidate.right) / 2;
      return centerDistance <= width * .28 && overlapFraction(best, candidate) >= .68;
    });
    if (matching) {
      matching.views.add(candidate.view);
    } else {
      groups.push({best: candidate, views: new Set([candidate.view])});
    }
  }
  return groups.map(({best, views}) => ({...best, viewCount: views.size,
    score: best.score + .6 * (views.size - 1)}));
}

function panesInWallView(pixels, mask, size, width, elevation) {
  const minWidth = Math.max(5, Math.ceil(.28 * size / width));
  const geometry = frameRectangles(mask, size, box => openingEvidence(mask, size, box));
  const dark = frameRectangles(pixels, size, box => darkPaneEvidence(pixels, mask, size, box));
  const seeds = [...geometry, ...dark].sort((a, b) => (b.top - b.y) - (a.top - a.y));
  const accepted = [];
  const rejected = [];
  if (seeds.length) {
    const seed = seeds[0];
    const split = splitWindowRow(pixels, mask, size,
      {x: 1, right: size - 1, y: seed.y, top: seed.top}, minWidth,
      Math.max(4, Math.round(.22 * size / width)));
    rejected.push(...split.rejected);
    if (split.panes.length) {
      for (const box of split.panes) {
        if (box.y * elevation / size < .2 || (box.top - box.y) * elevation / size < .35) {
          rejected.push({...box, reason: "outside the sill-to-header band"});
          continue;
        }
        accepted.push({...box, source: box.kind + " between mullions", score: box.score + 5});
      }
      return {accepted, rejected};
    }
  }
  const neighbors = adjacentPanes(pixels, mask, size, seeds, minWidth);
  for (const [boxes, source, priority] of [[geometry, "Framed opening in scan geometry", 4],
      [dark, "Dark pane with a bright frame", 3], [neighbors, "Pane along a detected window row", 0]]) {
    for (const box of boxes) {
      if (box.y * elevation / size < .35 || (box.top - box.y) * elevation / size < .35 ||
          (box.right - box.x) * width / size < .35) continue;
      if (accepted.some(other => overlapFraction(other, box) > .4)) continue;
      accepted.push({...box, source, score: box.score + priority});
    }
  }
  return {accepted, rejected};
}

function bandsOnWall(THREE, openings, wall) {
  const bands = [];
  for (const opening of openings) {
    if (!Array.isArray(opening?.corners) || opening.corners.length !== 4) continue;
    const points = opening.corners.map(point => new THREE.Vector3(...point));
    const distance = points.reduce((sum, point) => sum + Math.abs(wall.plane.distanceToPoint(point)), 0) / 4;
    if (distance > .4) continue;
    const along = points.map(point => point.clone().sub(wall.origin).dot(wall.axis));
    const low = Math.min(...along), high = Math.max(...along);
    if (high < -.15 || low > wall.width + .15 || high - low < .35) continue;
    const heights = points.map(point => point.y);
    bands.push({low, high, sill: Math.min(...heights), header: Math.max(...heights), opening, split: false});
  }
  return bands;
}

export function scanWindowCandidates(THREE, room, mesh, renderer, photoMaterial = object => object.material, openings = []) {
  const size = 160;
  const target = new THREE.WebGLRenderTarget(size, size);
  const previous = renderer.getRenderTarget();
  const mask = new Uint8Array(size*size*4);
  const pixels = new Uint8Array(size*size*4);
  const outline = room.outline;
  const winding = Math.sign(outline.reduce((sum, [x,z], i) => {
    const [u,v] = outline[(i+1)%outline.length];
    return sum+x*v-z*u;
  }, 0));
  const elevation = room.heightEstimated ? 3 : room.height || 3;
  const detectionScene = new THREE.Scene();
  detectionScene.background = new THREE.Color(0x000000);
  const surface = new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide, toneMapped: false});
  // Keep the original photographs as evidence even in Relit mode.
  const sourceMeshes = [];
  mesh.traverse(object => { if (object.isMesh) sourceMeshes.push(object); });
  const copy = mesh.clone(true);
  let sourceIndex = 0;
  copy.traverse(object => {
    if (object.isMesh) object.material = photoMaterial(sourceMeshes[sourceIndex++]);
  });
  detectionScene.add(copy);
  const walls = outline.slice(0, 32).map(([x, z], i) => {
    const [u, v] = outline[(i + 1) % outline.length];
    const width = Math.hypot(u - x, v - z);
    const axis = new THREE.Vector3((u - x) / width, 0, (v - z) / width);
    const outward = new THREE.Vector3((v - z) * winding / width, 0, (x - u) * winding / width);
    const origin = new THREE.Vector3(x, 0, z);
    const center = new THREE.Vector3((x + u) / 2, elevation / 2, (z + v) / 2);
    return {width, axis, outward, origin, center,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(outward, origin)};
  }).filter(wall => wall.width >= .4);
  const candidates = [];
  const rejected = [];
  try {
    for (const wall of walls) {
      const bands = bandsOnWall(THREE, openings, wall);
      const {width, center} = wall;
      // Pad past the outline ends and above the header. Recessed frames and
      // panes beside a corner otherwise fall outside the crop.
      const pad = .55;
      const y0 = -0.12 * elevation;
      const y1 = elevation * 1.12;
      const frameWidth = width + pad * 2;
      const frameHeight = y1 - y0;
      const camera = new THREE.OrthographicCamera(-frameWidth / 2, frameWidth / 2,
        y1 - elevation / 2, y0 - elevation / 2, .05, 6);
      camera.position.copy(center).addScaledVector(wall.outward, -1);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      const alongOf = a => (a / size - .5) * frameWidth + width / 2;
      const heightOf = b => y0 + b / size * frameHeight;
      const wallCandidates = [];
      const wallRejected = [];
      let foundGaps = false;
      renderer.setRenderTarget(target);
      for (const angle of [0, -27, 27]) {
        // Shear the rays while keeping pixels on the wall plane registered.
        // The wall is at view-space z=-1, so the offset cancels there.
        const shear = 2 * Math.tan(angle * Math.PI / 180) / width;
        camera.updateProjectionMatrix();
        camera.projectionMatrix.elements[8] = shear;
        camera.projectionMatrix.elements[12] += shear;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        // Occupancy stays against the wall so a machine in the room cannot fill a pane.
        // The slice runs from just inside the outline to a short way outside it.
        camera.position.copy(center).addScaledVector(wall.outward, -.28);
        camera.near = .05;
        camera.far = .9;
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
        camera.projectionMatrix.elements[8] = shear;
        camera.projectionMatrix.elements[12] += shear;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        detectionScene.overrideMaterial = surface;
        renderer.clear();
        renderer.render(detectionScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, mask);
        camera.position.copy(center).addScaledVector(wall.outward, -1);
        camera.near = .2;
        camera.far = 6;
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
        camera.projectionMatrix.elements[8] = shear;
        camera.projectionMatrix.elements[12] += shear;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        detectionScene.overrideMaterial = null;
        renderer.clear();
        renderer.render(detectionScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        if (angle === 0) {
          const metersX = frameWidth / size;
          const metersY = frameHeight / size;
          const wallX0 = Math.round(pad / frameWidth * size);
          const wallX1 = Math.round((pad + width) / frameWidth * size);
          const gaps = meshGapPanes(mask, size,
            Math.max(4, Math.round(.55 / metersX)),
            Math.max(6, Math.round(.7 / metersY)),
            Math.max(8, Math.round(2.7 / metersY)),
            Math.max(2, Math.round(.08 / metersX)),
            wallX0, wallX1, y0, metersY);
          if (gaps.panes.length) {
            foundGaps = true;
            for (const pane of gaps.panes) {
              const across = ((pane.right - pane.x) * metersX).toFixed(1);
              const tall = ((pane.top - pane.y) * metersY).toFixed(1);
              wallCandidates.push({...pane, view: angle,
                source: "Unscanned MatterPak opening, " + across + " m × " + tall + " m"});
            }
          }
        }
        if (foundGaps) continue;
        if (bands.length) {
          const px = along => ((along - width / 2) / frameWidth + .5) * size;
          const py = y => (y - y0) / frameHeight * size;
          for (const band of bands) {
            const box = {
              x: Math.round(THREE.MathUtils.clamp(px(band.low), 1, size - 2)),
              right: Math.round(THREE.MathUtils.clamp(px(band.high), 1, size - 2)),
              y: Math.round(THREE.MathUtils.clamp(py(band.sill), 1, size - 2)),
              top: Math.round(THREE.MathUtils.clamp(py(band.header), 1, size - 2)),
            };
            if (box.right - box.x < 5 || box.top - box.y < 5) continue;
            const split = splitWindowRow(pixels, mask, size, box,
              Math.max(5, Math.ceil(.28 * size / frameWidth)),
              Math.max(4, Math.round(.22 * size / frameWidth)),
              {trustOpening: true});
            if (split.panes.length > 1) {
              band.split = true;
              for (const pane of split.panes)
                wallCandidates.push({...pane, view: angle, score: pane.score + 6,
                  source: "Matterport opening, " + pane.kind + " between mullions"});
            }
          }
        } else {
          const view = panesInWallView(pixels, mask, size, frameWidth, frameHeight);
          for (const box of view.accepted) wallCandidates.push({...box, view: angle});
          for (const box of view.rejected) wallRejected.push({...box, view: angle});
        }
      }
      if (foundGaps) {
        // The empty scan regions are the windows. Color splits stay unused.
      } else if (bands.length && !bands.some(band => band.split)) {
        for (const band of bands) {
          candidates.push({
            corners: band.opening.corners,
            outward: band.opening.outward || wall.outward.toArray(),
            score: 5, confidence: .8, accepted: true,
            source: (band.opening.source || "Matterport opening") + " · confidence 0.80",
          });
        }
        continue;
      }
      const place = (box, accept) => {
        const centerAlong = (alongOf(box.x) + alongOf(box.right)) / 2;
        if (centerAlong < 0 || centerAlong > width) {
          rejected.push({reason: "pane center is outside this wall", accepted: false});
          return;
        }
        const corners = [[box.x, box.y], [box.right, box.y], [box.right, box.top], [box.x, box.top]]
          .map(([a, b]) => wall.origin.clone()
            .addScaledVector(wall.axis, THREE.MathUtils.clamp(alongOf(a), 0, width))
            .setY(heightOf(b)).toArray());
        const confidence = Math.max(0, Math.min(1, (box.confidence ?? box.score / 8)));
        const entry = {corners, outward: wall.outward.toArray(), score: box.score, confidence,
          accepted: accept, source: accept
            ? box.source + " · confidence " + confidence.toFixed(2)
            : "Rejected: " + (box.reason || "does not read as a pane")};
        (accept ? candidates : rejected).push(entry);
      };
      for (const box of mergePaneViews(wallCandidates)) {
        const agreement = box.viewCount > 1 ? " · " + box.viewCount + " angles agree" : "";
        place({...box, source: box.source + agreement, confidence: Math.min(1, box.score / 8)}, true);
      }
      for (const box of wallRejected.filter(item => item.reason === "solid column or wall").slice(0, 4))
        place(box, false);
    }
    const distinct = [];
    for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
      const center = candidate.corners.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0]);
      if (distinct.some(other => {
        const there = other.corners.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0]);
        return Math.hypot(center[0] - there[0], center[1] - there[1], center[2] - there[2]) < .22;
      })) continue;
      distinct.push(candidate);
    }
    console.info("Window detection", distinct.map(entry => entry.source),
      "rejected", rejected.map(entry => entry.source || entry.reason));
    const result = distinct.slice(0, 12);
    result.rejected = rejected.slice(0, 8);
    return result;
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    surface.dispose();
  }
}
