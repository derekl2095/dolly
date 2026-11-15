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

// An opening the mesh left empty, bounded by solid jambs on both sides.
// One hole the width of the wall is a missing wall. Two or more, split by a
// mullion, are a window wall even when the sill was never scanned.
export function framedVoidPanes(mask, size, minWidth, x0, x1, y0, y1) {
  const solidAt = (x, y) => x >= 0 && y >= 0 && x < size && y < size && mask[(y * size + x) * 4] > 127;
  if (y1 - y0 < 6 || x1 - x0 < minWidth) return [];
  const columns = [];
  const band = y1 - y0;
  for (let x = x0; x < x1; x++) {
    let empty = 0, streak = 0, longest = 0;
    for (let y = y0; y < y1; y++) {
      if (solidAt(x, y)) { streak++; longest = Math.max(longest, streak); }
      else { streak = 0; empty++; }
    }
    // A thin mullion is a vertical solid streak. Scattered holes are not a bar.
    columns.push({x, open: empty / band >= .55 && longest < band * .35});
  }
  const runs = [];
  let run = [];
  const flush = () => { if (run.length) runs.push(run); run = []; };
  for (const column of columns) {
    if (column.open) run.push(column);
    else if (run.length) flush();
  }
  flush();
  const panes = [];
  for (const group of runs) {
    if (group.length < minWidth || group.length > minWidth * 6) continue;
    const left = group[0].x - x0 - 1;
    const right = group.at(-1).x - x0 + 1;
    if (left < 0 || right >= columns.length || columns[left].open || columns[right].open) continue;
    panes.push({x: group[0].x, right: group.at(-1).x + 1, y: y0, top: y1, kind: "Mesh opening",
      score: group.length * (y1 - y0), confidence: .8,
      source: "Unscanned MatterPak opening"});
  }
  return panes;
}

// A pane is a stretch of wall the MatterPak never reconstructed: empty in the
// occupancy mask, with scanned mesh underneath it for a sill. A solid column
// wider than a mullion separates panes. Photo color is not used here.
export function meshGapPanes(mask, size, minWidth, minHeight, maxHeight, minDivider, x0 = 0, x1 = size, yOrigin = null, metersY = null, windowBand = {low: .75, high: 2.2}) {
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
        else if (metersY && yOrigin != null && height > maxHeight && top < size - 4) {
          // Keep the window band only when a real sill and a real header survive.
          // One solid pixel above an empty wall is not a header.
          const bandBottom = Math.max(0, Math.round((windowBand.low - yOrigin) / metersY));
          const bandTop = Math.min(top, Math.round((windowBand.high - yOrigin) / metersY));
          let openRows = 0, rows = 0, sill = 0, sillN = 0, header = 0, headerN = 0;
          for (let row = bandBottom; row < bandTop; row++) { rows++; openRows += open[row]; }
          for (let row = bandBottom - 6; row < bandBottom; row++) {
            if (row < 0) continue;
            sillN++;
            sill += solidAt(x, row) ? 1 : 0;
          }
          for (let row = bandTop; row < Math.min(size, bandTop + 5); row++) {
            headerN++;
            header += solidAt(x, row) ? 1 : 0;
          }
          if (rows >= minHeight && bandTop - bandBottom >= minHeight && openRows / rows >= .5 &&
              sillN >= 4 && sill / sillN >= .6 && headerN >= 3 && header / headerN >= .6)
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

function evenLuminance(values) {
  if (!values.length) return false;
  const third = Math.max(1, Math.floor(values.length / 3));
  const mean = group => group.reduce((sum, value) => sum + value, 0) / group.length;
  return Math.max(...values) - Math.min(...values) <= 48 &&
    Math.abs(mean(values.slice(0, third)) - mean(values.slice(-third))) <= 14;
}

// Photographed glass still has mesh, so occupancy will not see it. A pane here
// is darker or more broken up than the solid wall under it, and it stops at a
// jamb. A flat wall, and a hole that reaches the floor, stay out.
export function scannedGlazing(pixels, mask, size, minWidth, minHeight, x0, x1, bandY, bandTop) {
  const solidAt = (x, y) => x >= 0 && y >= 0 && x < size && y < size && mask[(y * size + x) * 4] > 127;
  const lumAt = (x, y) => {
    const i = (y * size + x) * 4;
    return .30 * pixels[i] + .59 * pixels[i + 1] + .11 * pixels[i + 2];
  };
  const y0 = Math.max(0, bandY | 0);
  const y1 = Math.min(size, bandTop | 0);
  const sill0 = Math.max(0, y0 - Math.max(4, Math.round((y1 - y0) * .4)));
  if (y1 - y0 < minHeight || x1 - x0 < minWidth) return {panes: []};
  const columns = [];
  for (let x = x0; x < x1; x++) {
    const band = [];
    let solidBand = 0, sillSolid = 0, sillN = 0;
    for (let y = y0; y < y1; y++) if (solidAt(x, y)) { solidBand++; band.push(lumAt(x, y)); }
    const sill = [];
    for (let y = sill0; y < y0; y++) {
      sillN++;
      if (solidAt(x, y)) { sillSolid++; sill.push(lumAt(x, y)); }
    }
    const filled = solidBand / Math.max(1, y1 - y0);
    const sillThere = sillN >= 4 && sillSolid / sillN >= .55 && sill.length >= 3;
    if (filled < .6 || !sillThere || band.length < minHeight * .5) {
      columns.push({x, glass: false});
      continue;
    }
    const bandLum = median(band);
    const sillLum = median(sill);
    let flips = 0, compared = 0, previous = null;
    for (let y = y0; y < y1; y++) {
      if (!solidAt(x, y)) { previous = null; continue; }
      const value = lumAt(x, y);
      if (previous != null) {
        compared++;
        if (Math.abs(value - previous) >= 36) flips++;
      }
      previous = value;
    }
    const slats = compared >= 6 && flips / compared >= .35;
    let deviation = 0;
    for (const value of band) deviation += (value - bandLum) ** 2;
    deviation = Math.sqrt(deviation / band.length);
    const brighter = bandLum - sillLum >= 28;
    const darker = sillLum - bandLum >= 24;
    // Repeating slats stay a window when their average matches the wall below.
    const blinds = (deviation >= 20 && Math.abs(sillLum - bandLum) >= 14) ||
      (slats && (Math.abs(sillLum - bandLum) >= 14 || flips / compared >= .45));
    let edgeSum = 0, edgeN = 0;
    if (x > x0) {
      for (let y = y0; y < y1; y++) {
        if (!solidAt(x, y) || !solidAt(x - 1, y)) continue;
        edgeSum += Math.abs(lumAt(x, y) - lumAt(x - 1, y));
        edgeN++;
      }
    }
    columns.push({x, glass: brighter || darker || blinds, blinds, bandLum, sillLum,
      edge: edgeN ? edgeSum / edgeN : 0});
  }
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    if (column.bandLum == null) continue;
    const side = direction => {
      let brightest = null;
      for (let step = 1; step <= 3; step++) {
        const lum = columns[index + direction * step]?.bandLum;
        if (lum == null) continue;
        brightest = brightest == null ? lum : Math.max(brightest, lum);
      }
      return brightest;
    };
    const left = side(-1);
    const right = side(1);
    if (left != null && right != null && left - column.bandLum >= 22 && right - column.bandLum >= 22) {
      column.glass = false;
      column.mullion = true;
    }
  }
  const panes = [];
  let run = [];
  let gap = 0;
  const splitAt = Math.max(2, Math.round(minWidth * .15));
  const flush = () => {
    if (run.length >= minWidth) {
      const busy = run.filter(column => column.blinds).length / run.length;
      const contrast = run.reduce((sum, column) => sum + Math.abs(column.sillLum - column.bandLum), 0) / run.length;
      const lums = run.map(column => column.bandLum);
      const runLum = median(lums);
      const flat = evenLuminance(lums);
      const at = x => columns[x - x0];
      const neighbors = [at(run[0].x - 1), at(run.at(-1).x + 1)].filter(column => column?.bandLum != null);
      const edged = neighbors.some(column => Math.abs(runLum - column.bandLum) >= 18);
      const spansWall = run.at(-1).x - run[0].x + 1 >= (x1 - x0) * .8;
      const frame = edged || run.some(column => column.edge >= 22) ||
        neighbors.some(column => column.edge >= 22);
      const header = [];
      for (const column of run) {
        for (let y = y1; y < Math.min(size, y1 + 8); y++) {
          if (solidAt(column.x, y)) header.push(lumAt(column.x, y));
        }
      }
      const headerLum = header.length >= 4 ? median(header) : null;
      // A long fade across a wall can look brighter than the sill. A compact
      // framed pane is allowed to vary, the way blinds do. A bright patch
      // whose wall continues above it is the same lit surface.
      const sameSurface = headerLum != null && runLum >= 150 && headerLum >= 145 &&
        Math.abs(headerLum - runLum) <= 28;
      const kept = !sameSurface && !spansWall && frame && (contrast >= 16 || busy >= .4) &&
        (edged || contrast >= 24 || busy >= .4) &&
        (run.length <= minWidth * 4 || flat);
      if (kept) {
        panes.push({x: run[0].x, right: run.at(-1).x + 1, y: y0, top: y1, kind: "Scanned glazing",
          score: (run.at(-1).x + 1 - run[0].x) * (y1 - y0) * .45, confidence: .78,
          source: "Scanned glazing"});
      }
    }
    run = [];
    gap = 0;
  };
  for (const column of columns) {
    if (!column.glass) {
      if (column.mullion && run.length) flush();
      if (run.length) gap++;
      if (gap >= splitAt) flush();
      continue;
    }
    if (gap >= splitAt) flush();
    gap = 0;
    run.push(column);
  }
  flush();
  // Floor-to-ceiling glass has no darker sill. A bank of bright panes between
  // mullions is still a window; one dark stripe on a bright wall is not.
  const framed = [];
  let between = [];
  const take = () => {
    const usable = between.filter(column => column.bandLum != null);
    if (usable.length >= minWidth && usable.length <= (x1 - x0) * .62) {
      const values = usable.map(column => column.bandLum);
      const lum = median(values);
      if (lum >= 145 && evenLuminance(values)) framed.push(usable);
    }
    between = [];
  };
  for (const column of columns) {
    if (column.mullion) take();
    else between.push(column);
  }
  take();
  if (framed.length >= 2) {
    for (const usable of framed) {
      const box = {x: usable[0].x, right: usable.at(-1).x + 1, y: y0, top: y1};
      const bounds = [columns[usable[0].x - x0 - 1], columns[usable.at(-1).x - x0 + 1]];
      if (!bounds.some(column => column?.mullion && (column.edge || 0) >= 16)) continue;
      if (panes.some(pane => overlapFraction(pane, box) >= .5)) continue;
      panes.push({...box, kind: "Scanned glazing",
        score: (box.right - box.x) * (y1 - y0) * .4, confidence: .74,
        source: "Scanned glazing"});
    }
  }
  return {panes};
}

export function clearPaneCandidates(pixels, mask, size, left, right, bottom, top, minWidth, metersX, metersY) {
  const scanBottom = Math.max(bottom, Math.round(bottom + (top - bottom) * .42));
  const minimumSky = Math.max(4, Math.round(.13 / metersY));
  const isSky = (x, y) => {
    const i = (y * size + x) * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    return mask[i] >= 128 && b >= 120 && b >= r + 13 && b >= g + 5;
  };
  const panes = [];
  let columns = [];
  const joinGap = Math.max(3, Math.round(.14 / metersX));
  function flush() {
    if (!columns.length) return;
    const x = columns[0].x, right = columns.at(-1).x + 1;
    if (right - x >= minWidth && columns.length >= (right - x) * .5) {
      const skyTop = median(columns.map(column => column.top));
      const skyBottom = median(columns.map(column => column.bottom));
      const centerLuminance = y => {
        const values = [];
        for (let col = x + 2; col < right - 2; col += 2) values.push(luminanceAt(pixels, size, col, y));
        return median(values);
      };
      // Require a horizontal trim edge above the blue region. Track the
      // vertical frame below it to estimate where the glass meets its sill.
      const headerEnd = Math.min(top - 2, skyTop + Math.round(.28 / metersY));
      let header, headerScore = 10;
      for (let y = Math.max(2, skyTop); y <= headerEnd; y++) {
        const score = Math.abs(centerLuminance(y + 1) - centerLuminance(y - 1));
        if (score > headerScore) { header = y; headerScore = score; }
      }
      if (header != null) {
        let sill = skyBottom, weak = 0;
        const bound = Math.max(bottom + 2, header - Math.round(2.8 / metersY));
        for (let y = skyBottom; y >= bound; y--) {
          const l = Math.abs(luminanceAt(pixels, size, x + 2, y) - luminanceAt(pixels, size, Math.max(0, x - 3), y));
          const r = Math.abs(luminanceAt(pixels, size, right - 3, y) - luminanceAt(pixels, size, Math.min(size - 1, right + 2), y));
          weak = Math.max(l, r) >= 12 ? 0 : weak + 1;
          if (weak > Math.max(6, Math.round(.22 / metersY))) break;
          if (!weak) sill = y;
        }
        if ((header - sill) * metersY >= .55)
          panes.push({x, right, y: sill, top: header, score: columns.length * 20,
            source: "Blue sky and photographed window frame"});
      }
    }
    columns = [];
  }
  for (let x = left; x < right; x++) {
    const skyRows = [];
    for (let y = scanBottom; y < top; y++) if (isSky(x, y)) skyRows.push(y);
    if (skyRows.length < minimumSky) continue;
    if (columns.length && x - columns.at(-1).x > joinGap) flush();
    columns.push({x, bottom: skyRows[0], top: skyRows.at(-1)});
  }
  flush();
  return panes;
}

// Floor-to-ceiling glazing often has no solid sill. Look for repeated horizontal
// slats across neighboring columns and keep this as texture evidence for review.
export function blindPaneCandidates(pixels, mask, size, left, right, bottom, top, minWidth) {
  if (top - bottom < 25 || right - left < minWidth) return [];
  const low = Math.max(2, bottom + Math.round((top - bottom) * .12));
  const high = Math.min(size - 2, top - Math.round((top - bottom) * .12));
  const middle = (low + high) / 2;
  const votingColumns = [];
  for (let x = Math.max(left, 2); x < Math.min(right, size - 2); x++) {
    let last = -4, lower = 0, upper = 0, light = 0, occupied = 0;
    for (let y = low; y < high; y++) {
      const value = luminanceAt(pixels, size, x, y);
      light += value;
      occupied += Number(mask[(y * size + x) * 4] > 127);
      if (y - last < 4) continue;
      const edge = offset => luminanceAt(pixels, size, x + offset, y + 1) -
        luminanceAt(pixels, size, x + offset, y - 1);
      const center = edge(0);
      if (Math.abs(center) < 9 || ![-2, 2].every(offset => edge(offset) * Math.sign(center) >= 5)) continue;
      last = y;
      if (y < middle) lower++;
      else upper++;
    }
    if (lower >= 2 && upper >= 2 && light / (high - low) < 145 && occupied / (high - low) >= .55)
      votingColumns.push(x);
  }
  const panes = [];
  let run = [];
  const maxGap = Math.max(2, Math.round(minWidth * .2));
  function flush() {
    if (run.length >= minWidth * .65 && run.at(-1) - run[0] + 1 >= minWidth) {
      panes.push({x: run[0], right: run.at(-1) + 1, y: bottom, top,
        source: "Glazing with repeated blind slats", score: run.length * 15});
    }
    run = [];
  }
  for (const x of votingColumns) {
    if (run.length && x - run.at(-1) > maxGap) flush();
    run.push(x);
  }
  flush();
  return panes;
}

// Daylight through a hole, as opposed to a black tear or an unscanned doorway.
export function daylightHole(pixels, mask, size, pane) {
  const lumAt = (x, y) => {
    const i = (y * size + x) * 4;
    return .30 * pixels[i] + .59 * pixels[i + 1] + .11 * pixels[i + 2];
  };
  let lum = 0, count = 0, wall = 0, wallCount = 0;
  const stepX = Math.max(1, Math.round((pane.right - pane.x) / 12));
  const stepY = Math.max(1, Math.round((pane.top - pane.y) / 12));
  for (let x = pane.x; x < pane.right; x += stepX) {
    for (let y = pane.y; y < pane.top; y += stepY) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      count++;
      lum += lumAt(x, y);
    }
  }
  const sampleWall = x => {
    for (let y = pane.y; y < pane.top; y += stepY) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if (mask[(y * size + x) * 4] < 128) continue;
      wallCount++;
      wall += lumAt(x, y);
    }
  };
  sampleWall(pane.x - 3);
  sampleWall(pane.right + 2);
  if (count < 4 || wallCount < 3) return false;
  return lum / count - wall / wallCount >= 32;
}

// A hole is a window when the photo inside it is a void or daylight. A hole
// that shows another scanned room is a doorway.
export function openingLooksLikeWindow(pixels, mask, size, pane) {
  const lumAt = (x, y) => {
    const i = (y * size + x) * 4;
    return .30 * pixels[i] + .59 * pixels[i + 1] + .11 * pixels[i + 2];
  };
  let lum = 0, count = 0, empty = 0;
  const stepX = Math.max(1, Math.round((pane.right - pane.x) / 12));
  const stepY = Math.max(1, Math.round((pane.top - pane.y) / 12));
  for (let x = pane.x; x < pane.right; x += stepX) {
    for (let y = pane.y; y < pane.top; y += stepY) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      count++;
      if (mask[(y * size + x) * 4] < 128) empty++;
      lum += lumAt(x, y);
    }
  }
  if (count < 4) return false;
  const inside = lum / count;
  if (empty / count >= .75 && inside < 22) return true;
  let wall = 0, wallCount = 0;
  const sampleWall = x => {
    for (let y = pane.y; y < pane.top; y += stepY) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if (mask[(y * size + x) * 4] < 128) continue;
      wallCount++;
      wall += lumAt(x, y);
    }
  };
  sampleWall(pane.x - 3);
  sampleWall(pane.right + 2);
  if (wallCount < 3) return false;
  const wallLum = wall / wallCount;
  // Daylight is brighter than the wall. A raised opening onto a darker
  // exterior is darker, and still a window.
  return inside - wallLum >= 32 || (empty / count >= .75 && wallLum - inside >= 30);
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

export function preferFramedSkyPanes(panes, hasOpeningEvidence = () => false) {
  const skyPanes = panes.filter(pane => pane.viewCount >= 2 && pane.source === "Blue sky and photographed window frame");
  return panes.filter(pane => !pane.source?.startsWith("Scanned glazing") || hasOpeningEvidence(pane) ||
    !skyPanes.some(sky => overlapFraction(sky, pane) >= .22));
}

export function paneHasOpeningEvidence(pane, wallPanes, openingBoxes, pixelsPerMeter) {
  if (pane.source?.startsWith("Unscanned MatterPak opening") || pane.source?.startsWith("Matterport opening")) return true;
  if (openingBoxes.some(box => overlapFraction(pane, box) >= .68)) return true;
  const alignment = Math.max(3, pixelsPerMeter * .18);
  return wallPanes.some(other => {
    if (!other.source?.startsWith("Unscanned MatterPak opening")) return false;
    const gap = Math.max(pane.x - other.right, other.x - pane.right, 0);
    return gap <= pixelsPerMeter * .35 && Math.abs(other.y - pane.y) <= alignment &&
      Math.min(other.top, pane.top) - Math.max(other.y, pane.y) >= (pane.top - pane.y) * .75;
  });
}

export function extendSharedPaneHeader(pane, wallPanes, pixelsXPerMeter, pixelsYPerMeter) {
  if (!pane.source?.startsWith("Scanned glazing")) return pane;
  const tolerance = Math.max(3, pixelsYPerMeter * .12);
  const neighbors = wallPanes.filter(other =>
    other.source?.startsWith("Unscanned MatterPak opening") && Math.abs(other.y - pane.y) <= tolerance &&
    other.top - pane.top >= tolerance && other.top - pane.top <= pixelsYPerMeter * .65);
  const left = neighbors.filter(other => other.right <= pane.x + pixelsXPerMeter * .12 &&
    pane.x - other.right <= pixelsXPerMeter * .35);
  const right = neighbors.filter(other => other.x >= pane.right - pixelsXPerMeter * .12 &&
    other.x - pane.right <= pixelsXPerMeter * .35);
  const match = left.flatMap(a => right.filter(b => Math.abs(a.top - b.top) <= tolerance)
    .map(b => Math.min(a.top, b.top)));
  return match.length ? {...pane, top: Math.min(...match), sharedHeader: true} : pane;
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

export function windowSearchScale(room, openings = []) {
  const header = openings.reduce((top, opening) => Math.max(top, ...(opening.corners ?? [])
    .map(point => point?.[1]).filter(Number.isFinite)), 0);
  const reported = Number.isFinite(room.height) && room.height > 0 ? room.height : 3;
  const elevation = Math.max(reported, header + .15);
  return {elevation, low: elevation * .25, high: elevation * (2.2 / 3),
    minSill: Math.min(.35, elevation * .12), maxPaneHeight: Math.max(2.7, elevation * .9)};
}

export function scanWindowCandidates(THREE, room, mesh, renderer, photoMaterial = object => object.material, openings = []) {
  const target = new THREE.WebGLRenderTarget(160, 160);
  const previous = renderer.getRenderTarget();
  const savedTone = renderer.toneMapping;
  const savedSpace = renderer.outputColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const outline = room.outline;
  const winding = Math.sign(outline.reduce((sum, [x,z], i) => {
    const [u,v] = outline[(i+1)%outline.length];
    return sum+x*v-z*u;
  }, 0));
  const scale = windowSearchScale(room, openings);
  const {elevation} = scale;
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
  const walls = outline.map(([x, z], i) => {
    const [u, v] = outline[(i + 1) % outline.length];
    const width = Math.hypot(u - x, v - z);
    if (width < .4) return null;
    const axis = new THREE.Vector3((u - x) / width, 0, (v - z) / width);
    const outward = new THREE.Vector3((v - z) * winding / width, 0, (x - u) * winding / width);
    const origin = new THREE.Vector3(x, 0, z);
    const center = new THREE.Vector3((x + u) / 2, elevation / 2, (z + v) / 2);
    return {width, axis, outward, origin, center,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(outward, origin)};
  }).filter(Boolean);
  const candidates = [];
  const rejected = [];
  const wallViews = [];
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
      const size = Math.max(160, Math.min(384, Math.ceil(Math.max(frameWidth, frameHeight) * 24)));
      target.setSize(size, size);
      const mask = new Uint8Array(size * size * 4);
      const pixels = new Uint8Array(size * size * 4);
      const camera = new THREE.OrthographicCamera(-frameWidth / 2, frameWidth / 2,
        y1 - elevation / 2, y0 - elevation / 2, .05, 6);
      camera.position.copy(center).addScaledVector(wall.outward, -1);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      const alongOf = a => (a / size - .5) * frameWidth + width / 2;
      const heightOf = b => y0 + b / size * frameHeight;
      const wallCandidates = [];
      const wallRejected = [];
      const views = new Map();

      renderer.setRenderTarget(target);
      for (const angle of [0, -27, 27]) {
        const shear = 2 * Math.tan(angle * Math.PI / 180) / frameWidth;
        function register(distance, near, far) {
          camera.position.copy(center).addScaledVector(wall.outward, -distance);
          camera.near = near;
          camera.far = far;
          camera.updateMatrixWorld();
          camera.updateProjectionMatrix();
          // The wall is at view-space z = -distance in each pass.
          camera.projectionMatrix.elements[8] = shear;
          camera.projectionMatrix.elements[12] += shear * distance;
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        }
        // The occupancy pass excludes foreground objects well inside the room.
        register(.28, .05, .9);
        detectionScene.overrideMaterial = surface;
        renderer.clear();
        renderer.render(detectionScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, mask);
        register(1, .2, 6);
        detectionScene.overrideMaterial = null;
        renderer.clear();
        renderer.render(detectionScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        const beforeView = wallCandidates.length;
        {
          const before = wallCandidates.length;
          const metersX = frameWidth / size;
          const metersY = frameHeight / size;
          const wallX0 = Math.round(pad / frameWidth * size);
          const wallX1 = Math.round((pad + width) / frameWidth * size);
          const gaps = meshGapPanes(mask, size,
            Math.max(4, Math.round(.55 / metersX)),
            Math.max(6, Math.round(.7 / metersY)),
            Math.max(8, Math.round(scale.maxPaneHeight / metersY)),
            Math.max(2, Math.round(.08 / metersX)),
            wallX0, wallX1, y0, metersY, scale);
          const emptyShare = (lowMeter, highMeter) => {
            const yA = Math.max(0, Math.round((lowMeter - y0) / frameHeight * size));
            const yB = Math.min(size, Math.round((highMeter - y0) / frameHeight * size));
            let empty = 0, count = 0;
            for (let x = wallX0; x < wallX1; x += 2) {
              for (let y = yA; y < yB; y += 2) {
                count++;
                if (mask[(y * size + x) * 4] < 128) empty++;
              }
            }
            return count ? empty / count : 0;
          };
          const shape = {below: emptyShare(0, scale.low * .8), band: emptyShare(scale.low, scale.high), above: emptyShare(scale.high, elevation)};
          if (gaps.panes.length) {
            for (const pane of gaps.panes) {
              const wide = (pane.right - pane.x) * metersX;
              const high = (pane.top - pane.y) * metersY;
              // A missing wall is wide and unframed. A short hole is a gap, not a pane.
              const sill = y0 + pane.y * metersY;
              if (wide > 8 || wide < .45 || high < .7) continue;
              // A short opening at the floor is a gap. One in the top of the
              // room is the ceiling edge, not a pane. One that reaches the
              // floor is a door. A tall black slit is a tear, not a window.
              if (high < 1 && (wide > 1.6 || sill < .9)) continue;
              if (sill < scale.minSill || sill > elevation - .55) continue;
              if (sill + high > elevation + .15 && sill > elevation - 1) continue;
              if (high > 1.8 && high > wide * 2.2 && sill < .6 && !daylightHole(pixels, mask, size, pane)) continue;
              if (!openingLooksLikeWindow(pixels, mask, size, pane)) continue;
              const across = wide.toFixed(1);
              const tall = high.toFixed(1);
              wallCandidates.push({...pane, view: angle,
                source: "Unscanned MatterPak opening, " + across + " m × " + tall + " m"});
            }
          }
          const rowOf = meters => Math.round((meters - y0) / frameHeight * size);
          const bandLow = rowOf(scale.low);
          const bandHigh = rowOf(scale.high);
          if (shape.band >= .45) {
            const voids = framedVoidPanes(mask, size,
              Math.max(4, Math.round(.55 / metersX)), wallX0, wallX1, bandLow, bandHigh);
            const shell = shape.below >= .68 && shape.above >= .68 && shape.band >= .68;
            if (!(shell && voids.length < 2)) {
              for (const pane of voids) {
                if (wallCandidates.some(other => other.view === angle && overlapFraction(other, pane) >= .45)) continue;
                const wide = (pane.right - pane.x) * metersX;
                if (wide < .45 || wide > 3.2) continue;
                if (!openingLooksLikeWindow(pixels, mask, size, pane)) continue;
                wallCandidates.push({...pane, view: angle,
                  source: "Unscanned MatterPak opening, " + wide.toFixed(1) + " m × " +
                    ((pane.top - pane.y) * metersY).toFixed(1) + " m"});
              }
            }
          }
          const glazedMinW = Math.max(4, Math.round(.55 / metersX));
          const glazedMinH = Math.max(6, Math.round(.7 / metersY));
          for (const [low, high] of [[scale.low, scale.high], [scale.minSill, elevation - .15]]) {
            const glazed = scannedGlazing(pixels, mask, size, glazedMinW, glazedMinH,
              wallX0, wallX1, rowOf(low), rowOf(high));
            for (const pane of glazed.panes) {
              if (wallCandidates.some(other => other.view === angle && overlapFraction(other, pane) >= .45)) continue;
              const across = ((pane.right - pane.x) * metersX).toFixed(1);
              const tall = ((pane.top - pane.y) * metersY).toFixed(1);
              wallCandidates.push({...pane, view: angle,
                source: "Scanned glazing, " + across + " m × " + tall + " m"});
            }
          }
          for (const pane of clearPaneCandidates(pixels, mask, size, wallX0, wallX1,
            rowOf(.04), rowOf(elevation - .08), glazedMinW, metersX, metersY)) {
            wallCandidates.push({...pane, view: angle});
          }
          for (const pane of blindPaneCandidates(pixels, mask, size, wallX0, wallX1,
            rowOf(.04), rowOf(elevation - .08), glazedMinW)) {
            if (wallCandidates.some(other => other.view === angle && overlapFraction(other, pane) >= .5)) continue;
            wallCandidates.push({...pane, view: angle});
          }
          if (wallCandidates.length === before && !bands.length) {
            const fallback = panesInWallView(pixels, mask, size, frameWidth, frameHeight);
            wallCandidates.push(...fallback.accepted.map(pane => ({...pane, view: angle})));
            wallRejected.push(...fallback.rejected);
          }
        }
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
        }
        if (wallCandidates.length !== beforeView || angle === 0)
          views.set(angle, pixels.slice());
      }
      if (views.get(0)) wallViews.push({size, frameWidth, frameHeight, pixels: views.get(0)});
      const preview = box => ({size, frameWidth, frameHeight, box, pixels: views.get(box.view ?? 0)});
      const allPanes = mergePaneViews(wallCandidates);
      const openingBox = band => ({x: (band.low + pad) / frameWidth * size, right: (band.high + pad) / frameWidth * size,
        y: (band.sill - y0) / frameHeight * size, top: (band.header - y0) / frameHeight * size});
      const openingBoxes = bands.map(openingBox);
      const merged = preferFramedSkyPanes(allPanes,
        pane => paneHasOpeningEvidence(pane, allPanes, openingBoxes, size / frameWidth));
      for (const band of bands.filter(band => !band.split)) {
        const box = openingBox(band);
        // A broad opening can cover several narrower, already detected panes.
        if (merged.some(candidate => overlapFraction(candidate, box) >= .68)) continue;
        candidates.push({
          corners: band.opening.corners,
          outward: band.opening.outward || wall.outward.toArray(),
          score: 5, confidence: .8, accepted: true, openingEvidence: true, preview: preview(box),
          source: band.opening.source || "Matterport opening",
        });
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
          accepted: accept, preview: accept ? preview(box) : undefined,
          openingEvidence: accept && paneHasOpeningEvidence(box, merged, openingBoxes, size / frameWidth),
          source: accept
            ? box.source
            : "Rejected: " + (box.reason || "does not read as a pane")};
        (accept ? candidates : rejected).push(entry);
      };
      for (const box of merged) {
        const pane = extendSharedPaneHeader(box, merged, size / frameWidth, size / frameHeight);
        const agreement = box.viewCount > 1 ? " · " + box.viewCount + " angles agree" : "";
        const source = pane.sharedHeader
          ? `Scanned glazing, ${((pane.right - pane.x) * frameWidth / size).toFixed(1)} m × ${((pane.top - pane.y) * frameHeight / size).toFixed(1)} m · shared header`
          : pane.source;
        place({...pane, source: source + agreement,
          confidence: Math.min(1, pane.score / 8)}, true);
      }
      for (const box of wallRejected.filter(item => item.reason === "solid column or wall").slice(0, 4))
        place(box, false);
    }
    const distinct = [];
    for (const candidate of candidates.sort((a, b) => Number(b.openingEvidence) - Number(a.openingEvidence) || b.score - a.score)) {
      const center = candidate.corners.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0]);
      if (distinct.some(other => {
        const there = other.corners.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0]);
        return Math.hypot(center[0] - there[0], center[1] - there[1], center[2] - there[2]) < .22;
      })) continue;
      distinct.push(candidate);
    }
    const result = distinct.slice(0, 32);
    result.rejected = rejected.slice(0, 8);
    result.wallViews = wallViews;
    return result;
  } finally {
    renderer.toneMapping = savedTone;
    renderer.outputColorSpace = savedSpace;
    renderer.setRenderTarget(previous);
    target.dispose();
    surface.dispose();
  }
}
