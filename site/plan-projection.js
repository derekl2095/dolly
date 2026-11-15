// Orthographic room view. Dragging projects back onto the mark's height plane.
export function planProjection({center, origin, scale, bearing, elevation}) {
  const c = Math.cos(bearing), s = Math.sin(bearing);
  const pitch = Math.sin(elevation), rise = Math.cos(elevation);
  return {
    project([x, z], height = 0) {
      const dx = x - center[0], dz = z - center[1];
      return [origin[0] + scale * (c * dx - s * dz),
        origin[1] + scale * ((s * dx + c * dz) * pitch - height * rise)];
    },
    unproject([x, y], height = 0) {
      const across = (x - origin[0]) / scale;
      const depth = ((y - origin[1]) / scale + height * rise) / pitch;
      return [center[0] + c * across + s * depth, center[1] - s * across + c * depth];
    },
    floorTransform: [c * scale, s * scale * pitch, -s * scale, c * scale * pitch, ...origin],
  };
}
