import type { Project } from '../project/project';
import { listScreens, loadScreen } from '../project/screens';
import { readSelection } from '../project/selection';
import type { SelectorEnv } from './resolve';

/** Selector environment backed by the documents on disk. */
export function projectSelectorEnv(project: Project, currentScreen?: string): SelectorEnv {
  return {
    currentScreen,
    listScreens: () => listScreens(project),
    loadScreen: (name) => loadScreen(project, name),
    selection: () => readSelection(project),
  };
}
