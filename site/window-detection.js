// Find rectangles with contrast along all four sides. These are review suggestions.
export function frameRectangles(pixels, size) {
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
  for (const box of found.sort((a,b) => b.score-a.score)) {
    if (best.some(other => Math.min(other.right,box.right)-Math.max(other.x,box.x) > 0 &&
        Math.min(other.top,box.top)-Math.max(other.y,box.y) > 0)) continue;
    best.push(box);
    if (best.length === 3) break;
  }
  return best;
}

export function scanWindowCandidates(THREE, room, mesh, renderer) {
  const size = 96;
  const target = new THREE.WebGLRenderTarget(size, size);
  const previous = renderer.getRenderTarget();
  const pixels = new Uint8Array(size*size*4);
  const outline = room.outline;
  const winding = Math.sign(outline.reduce((sum, [x,z], i) => {
    const [u,v] = outline[(i+1)%outline.length];
    return sum+x*v-z*u;
  }, 0));
  const elevation = room.heightEstimated ? 3 : room.height || 3;
  const detectionScene = new THREE.Scene();
  detectionScene.background = new THREE.Color(0x202021);
  detectionScene.add(mesh.clone(true));
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
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(detectionScene,camera);
      renderer.readRenderTargetPixels(target,0,0,size,size,pixels);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(outward,center);
      const ray = new THREE.Raycaster();
      const project = (a,b) => {
        ray.setFromCamera(new THREE.Vector2(2*a/size-1,2*b/size-1),camera);
        return ray.ray.intersectPlane(plane,new THREE.Vector3()).toArray();
      };
      for (const box of frameRectangles(pixels,size)) {
        if (box.y * elevation / size < .35 || (box.top-box.y)*elevation/size < .35 ||
            (box.right-box.x)*width/size < .35) continue;
        const corners = [project(box.x,box.y),project(box.right,box.y),
          project(box.right,box.top),project(box.x,box.top)];
        candidates.push({corners,outward:outward.toArray(),source:"Textured wall frame candidate",score:box.score});
      }
    }
    return candidates.sort((a,b) => b.score-a.score).slice(0,8);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
  }
}
