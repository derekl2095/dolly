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
  const geometry = frameRectangles(mask, size, box => openingEvidence(mask, size, box));
  const dark = frameRectangles(pixels, size, box => darkPaneEvidence(pixels, mask, size, box));
  const neighbors = adjacentPanes(pixels, mask, size, [...geometry, ...dark],
    Math.max(5, Math.ceil(.28 * size / width)));
  const accepted = [];
  for (const [boxes, source, priority] of [[geometry, "Framed opening in scan geometry", 4],
      [dark, "Dark pane with a bright frame", 3], [neighbors, "Pane along a detected window row", 0]]) {
    for (const box of boxes) {
      if (box.y * elevation / size < .35 || (box.top - box.y) * elevation / size < .35 ||
          (box.right - box.x) * width / size < .35) continue;
      if (accepted.some(other => overlapFraction(other, box) > .4)) continue;
      accepted.push({...box, source, score: box.score + priority});
    }
  }
  return accepted;
}

export function scanWindowCandidates(THREE, room, mesh, renderer, photoMaterial = object => object.material) {
  const size = 96;
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
  const candidates = [];
  try {
    for (const [i,[x,z]] of outline.slice(0, 32).entries()) {
      const [u,v] = outline[(i+1)%outline.length];
      const width = Math.hypot(u-x,v-z);
      if (width < .7) continue;
      const outward = new THREE.Vector3((v-z)*winding/width,0,(x-u)*winding/width);
      const center = new THREE.Vector3((x+u)/2,elevation/2,(z+v)/2);
      const camera = new THREE.OrthographicCamera(-width/2,width/2,elevation/2,-elevation/2,.5,1.5);
      camera.position.copy(center).addScaledVector(outward,-1);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const project = (a, b) => center.clone()
        .addScaledVector(right, (a / size - .5) * width)
        .add(new THREE.Vector3(0, (b / size - .5) * elevation, 0)).toArray();
      const wallCandidates = [];
      renderer.setRenderTarget(target);
      for (const angle of [0, -27, 27]) {
        // Shear the rays while keeping pixels on the wall plane registered.
        // The wall is at view-space z=-1, so the offset cancels there.
        const shear = 2 * Math.tan(angle * Math.PI / 180) / width;
        camera.updateProjectionMatrix();
        camera.projectionMatrix.elements[8] = shear;
        camera.projectionMatrix.elements[12] += shear;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        detectionScene.overrideMaterial = surface;
        renderer.clear();
        renderer.render(detectionScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, mask);
        detectionScene.overrideMaterial = null;
        renderer.clear();
        renderer.render(detectionScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        for (const box of panesInWallView(pixels, mask, size, width, elevation))
          wallCandidates.push({...box, view: angle});
      }
      for (const box of mergePaneViews(wallCandidates)) {
        const corners = [project(box.x, box.y), project(box.right, box.y),
          project(box.right, box.top), project(box.x, box.top)];
        candidates.push({corners, outward: outward.toArray(), score: box.score,
          source: box.viewCount > 1 ? box.source + " · " + box.viewCount + " angles agree" : box.source});
      }
    }
    return candidates.sort((a,b) => b.score-a.score).slice(0,8);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    surface.dispose();
  }
}
