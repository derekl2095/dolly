/** Sun position for an interior, and whether that sun is in front of a window. */

export const GREENWAY_LIGHT = {
  modelId: "39kv7R6xV7o",
  latitude: 29.73301,
  longitude: -95.4350352,
  year: 2025,
  month: 4,
  day: 10,
  // Floor-plan +x points into the room. This wall faces the opposite way.
  window: {sill: 0.77, height: 2.022, width: 2.195, outward: {x: -1, y: 0, z: 0},
    center: {x: -5.105, z: -0.487}},
};

function dayOfYear(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
}

function nthSunday(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + (7 - first) % 7 + (n - 1) * 7;
}

/** Hours added to UTC to get US Central civil time. Daylight time is the March–November window. */
export function centralOffsetHours(year, month, day) {
  const afterStart = month > 3 || (month === 3 && day >= nthSunday(year, 3, 2));
  const beforeEnd = month < 11 || (month === 11 && day < nthSunday(year, 11, 1));
  return afterStart && beforeEnd ? -5 : -6;
}

/**
 * Solar elevation and azimuth at a clock hour.
 * Azimuth is degrees clockwise from true north. The direction points toward the sun.
 */
export function sunPosition({latitude, longitude, year, month, day, hour, minute = 0, offsetHours}) {
  const clock = hour + minute / 60;
  const gamma = 2 * Math.PI / 365 * (dayOfYear(year, month, day) - 1 + (clock - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const hourAngle = (clock * 60 + eqtime + 4 * longitude - 60 * offsetHours) / 4 - 180;
  const lat = latitude * Math.PI / 180;
  const ha = hourAngle * Math.PI / 180;
  const elevation = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(decl) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  const east = Math.sin(azimuth) * Math.cos(elevation);
  const north = Math.cos(azimuth) * Math.cos(elevation);
  return {
    elevation: elevation * 180 / Math.PI,
    azimuth: (azimuth * 180 / Math.PI + 360) % 360,
    east, north, up: Math.sin(elevation),
  };
}

/**
 * Rotate a compass sun into the floor plan.
 * `heading` is the compass bearing, clockwise from north, of plan +z.
 * Plan +x is then 90° clockwise from +z, and y is up.
 */
export function modelDirection(sun, heading) {
  const bearing = heading * Math.PI / 180;
  return {
    x: sun.east * Math.cos(bearing) - sun.north * Math.sin(bearing),
    y: sun.up,
    z: sun.east * Math.sin(bearing) + sun.north * Math.cos(bearing),
  };
}

/** How strongly the sun lights the outside of the glass. Zero when it is down or behind the wall. */
export function glassGain(direction, outward) {
  if (direction.y <= 0) return 0;
  const facing = outward.x * direction.x + outward.y * direction.y + outward.z * direction.z;
  return facing > 0 ? direction.y * facing : 0;
}

export function sunlight({latitude, longitude, year, month, day, hour, heading, outward}) {
  const sun = sunPosition({
    latitude, longitude, year, month, day, hour,
    offsetHours: centralOffsetHours(year, month, day),
  });
  const direction = modelDirection(sun, heading);
  return {...sun, direction, gain: glassGain(direction, outward)};
}
