import {tracePath} from "./path.js?v=spatial-plan";
import {maxActors} from "./room-state.js?v=spatial-plan";

const storageKey = "scout-projects-v1";
export const projectArchiveMaxBytes = 1_000_000;

export function readProjects(storage = localStorage) {
  const data = storage.getItem(storageKey);
  if (!data) return [];
  const projects = JSON.parse(data);
  if (!Array.isArray(projects)) throw Error("Saved projects could not be read.");
  return projects;
}

export function writeProject(project, storage = localStorage) {
  const projects = readProjects(storage);
  const index = projects.findIndex(item => item.id === project.id);
  const saved = {...project, updatedAt: new Date().toISOString()};
  if (index < 0) projects.push(saved);
  else projects[index] = saved;
  storage.setItem(storageKey, JSON.stringify(projects));
  return saved;
}

export function deleteProject(id, storage = localStorage) {
  const projects = readProjects(storage);
  storage.setItem(storageKey, JSON.stringify(projects.filter(project => project.id !== id)));
}

export function parseProjectArchive(text) {
  const {version, project} = JSON.parse(text);
  const isObject = value => value && typeof value === "object" && !Array.isArray(value);
  const isText = (value, max) => typeof value === "string" && value.length <= max;
  const optionalText = (value, max) => value == null || isText(value, max);
  const settingsValid = settings => settings == null || (isObject(settings) &&
    optionalText(settings.brief, 1200) && optionalText(settings.lens, 32) &&
    optionalText(settings.minimumTravel, 32) && optionalText(settings.city, 80) &&
    optionalText(settings.category, 80) &&
    ["lockRoom", "requireSightlines", "apply", "shortlistOnly"].every(key =>
      settings[key] == null || typeof settings[key] === "boolean"));
  const filtersValid = filters => filters == null || (isObject(filters) &&
    optionalText(filters.city, 80) && optionalText(filters.category, 80));
  const shortlistValid = entries => entries == null || (Array.isArray(entries) && entries.length <= 30 &&
    entries.every(item => isObject(item) && isText(item.label, 500) && isText(item.caption, 500) &&
      isText(item.modelId, 40) && /^[A-Za-z0-9]+$/.test(item.modelId)));
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  const selectionValid = selection => {
    if (selection == null) return true;
    if (!isObject(selection) || !/^[A-Za-z0-9]{1,40}$/.test(selection.modelId || "") ||
        (selection.roomId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(selection.roomId)) ||
        !optionalText(selection.label, 500) || !optionalText(selection.location, 1000)) return false;
    const shot = selection.shot;
    return shot == null || (isObject(shot) && point(shot.mark) && point(shot.aim) &&
      (shot.axis == null || point(shot.axis)) &&
      (shot.moveKind === "curve" ? Boolean(tracePath(shot.pathPoints)) : shot.pathPoints == null) &&
      Number.isFinite(shot.lens) && shot.lens >= 15 && shot.lens <= 150 &&
      Number.isFinite(shot.travel) && shot.travel >= 0 && shot.travel <= 4 &&
      Array.isArray(shot.actors) && shot.actors.length >= 2 && shot.actors.length <= maxActors &&
      shot.actors.every(actor => actor == null || point(actor)) &&
      (shot.obstacles == null || (Array.isArray(shot.obstacles) &&
        shot.obstacles.every(item => isObject(item) && isText(item.name, 500) &&
          (item.height == null || (Number.isFinite(item.height) && item.height >= 0 && item.height <= 12)) &&
          point(item.min) && point(item.max) && item.min.every((value, index) => value < item.max[index])))));
  };
  if (version !== 1 || !isObject(project) || !isText(project.title, 100) ||
      !project.title.trim() || !selectionValid(project.selection) ||
      (project.query != null && !isText(project.query, 240)) ||
      !settingsValid(project.settings) || !filtersValid(project.filters) || !shortlistValid(project.shortlist) ||
      !Array.isArray(project.revisions) || project.revisions.length > 20 ||
      !project.revisions.every(item => isObject(item) && isText(item.brief, 1200) &&
        selectionValid(item.selection) && (item.activity == null ||
          (Array.isArray(item.activity) && item.activity.every(step => isText(step, 10000)))))) {
    throw Error("This file is not a supported scouting project.");
  }
  return project;
}
