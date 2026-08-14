import { buildDetailsScreenModel } from "./model";
import type {
  DetailsScreenModel,
  MainScreenModel,
  MainScreenRowId,
} from "./types";

export type TuiScreen = "main" | "details" | "confirm-uninstall";

export interface TuiAppState {
  screen: TuiScreen;
  selectedRow: number;
  selectedAction: number;
  pendingDetailsFor: MainScreenRowId | null;
  error: string | null;
  /** What an action reported that is not a failure. Start returns its findings
   *  rather than printing them: this renderer's writeLine goes nowhere, so a
   *  printed one would leave the screen claiming a clean start. */
  notice: string[] | null;
}

export interface TuiAppActions {
  /** Returns the lines to render beside the screen, if any. */
  start: () => Promise<string[] | void>;
  stop: () => Promise<void>;
  update: (version: string) => Promise<void>;
  uninstall: (moduleId: string) => Promise<void>;
}

export interface CreateTuiAppParams {
  model: MainScreenModel;
  actions: TuiAppActions;
  reloadModel?: () => Promise<MainScreenModel>;
}

export interface TuiApp {
  model: () => Readonly<MainScreenModel>;
  detailsModel: () => Readonly<DetailsScreenModel> | null;
  state: () => TuiAppState;
  moveRow: (delta: number) => void;
  moveAction: (delta: number) => void;
  activate: () => Promise<void>;
  goBack: () => void;
}

export function createTuiApp(params: CreateTuiAppParams): TuiApp {
  let currentModel = params.model;
  let currentDetailsModel: DetailsScreenModel | null = null;

  const currentState: TuiAppState = {
    screen: "main",
    selectedRow: 0,
    selectedAction: 0,
    pendingDetailsFor: null,
    error: null,
    notice: null,
  };

  const enterMain = () => {
    currentState.screen = "main";
    currentState.pendingDetailsFor = null;
    currentState.selectedAction = 0;
    currentDetailsModel = null;
  };

  const enterDetails = (id: MainScreenRowId) => {
    const row = currentModel.rows.find((r) => r.id === id);
    currentDetailsModel = buildDetailsScreenModel({
      id,
      installedVersion: row?.installedVersion ?? null,
      availableVersion: row?.availableVersion ?? null,
    });
    currentState.screen = "details";
    currentState.pendingDetailsFor = id;
    currentState.selectedAction = 0;
  };

  const enterConfirmUninstall = () => {
    currentState.screen = "confirm-uninstall";
    currentState.selectedAction = 0;
  };

  const refreshModel = async () => {
    if (!params.reloadModel) return;
    await params.reloadModel()
      .then((m) => {
        currentModel = m;
        const newActions = currentRow(m, currentState.selectedRow).actions;
        if (currentState.selectedAction >= newActions.length) {
          currentState.selectedAction = 0;
        }
      })
      .catch(() => {});
  };

  const actionCountForScreen = (): number => {
    switch (currentState.screen) {
      case "main":
        return currentRow(currentModel, currentState.selectedRow).actions.length;
      case "details":
        return currentDetailsModel?.actions.length ?? 1;
      case "confirm-uninstall":
        return 2;
    }
  };

  return {
    model: () => currentModel,
    detailsModel: () => currentDetailsModel,
    state: () => ({ ...currentState }),
    moveRow: (delta) => {
      if (currentState.screen !== "main") return;
      const nextRow = wrapIndex(
        currentState.selectedRow + delta,
        currentModel.rows.length,
      );

      if (nextRow !== currentState.selectedRow) {
        currentState.selectedRow = nextRow;
        currentState.selectedAction = 0;
      }
    },
    moveAction: (delta) => {
      const count = actionCountForScreen();
      currentState.selectedAction = wrapIndex(
        currentState.selectedAction + delta,
        count,
      );
    },
    goBack: () => {
      switch (currentState.screen) {
        case "main":
          return;
        case "details":
          enterMain();
          return;
        case "confirm-uninstall":
          currentState.screen = "details";
          currentState.selectedAction = 0;
          return;
      }
    },
    activate: async () => {
      currentState.error = null;
      currentState.notice = null;

      try {
        switch (currentState.screen) {
          case "main":
            await activateMain(currentModel, currentState, params.actions, enterDetails, enterMain, refreshModel);
            return;
          case "details":
            await activateDetails(currentDetailsModel, currentState, params.actions, enterMain, enterConfirmUninstall, refreshModel);
            return;
          case "confirm-uninstall":
            await activateConfirmUninstall(currentState, currentDetailsModel, params.actions, enterMain, refreshModel);
            return;
        }
      } catch (error) {
        currentState.error = errorMessage(error);
      }
    },
  };
}

async function activateMain(
  model: MainScreenModel,
  state: TuiAppState,
  handlers: TuiAppActions,
  enterDetails: (id: MainScreenRowId) => void,
  enterMain: () => void,
  refreshModel: () => Promise<void>,
): Promise<void> {
  const row = currentRow(model, state.selectedRow);
  const action = row.actions[state.selectedAction];

  if (!action || !action.enabled) return;

  switch (action.kind) {
    case "start": {
      const notice = await handlers.start();
      if (notice && notice.length > 0) state.notice = notice;
      enterMain();
      await refreshModel();
      return;
    }
    case "stop":
      await handlers.stop();
      enterMain();
      await refreshModel();
      return;
    case "update":
      await handlers.update(action.version);
      enterMain();
      await refreshModel();
      return;
    case "view-details":
      enterDetails(row.id);
      return;
  }
}

async function activateDetails(
  detailsModel: DetailsScreenModel | null,
  state: TuiAppState,
  handlers: TuiAppActions,
  enterMain: () => void,
  enterConfirmUninstall: () => void,
  refreshModel: () => Promise<void>,
): Promise<void> {
  if (!detailsModel) return;

  const action = detailsModel.actions[state.selectedAction];
  if (!action || !action.enabled) return;

  switch (action.kind) {
    case "update":
      await handlers.update(action.version);
      enterMain();
      await refreshModel();
      return;
    case "uninstall":
      enterConfirmUninstall();
      return;
    case "back":
      enterMain();
      return;
  }
}

async function activateConfirmUninstall(
  state: TuiAppState,
  detailsModel: DetailsScreenModel | null,
  handlers: TuiAppActions,
  enterMain: () => void,
  refreshModel: () => Promise<void>,
): Promise<void> {
  if (state.selectedAction === 0) {
    const moduleId = state.pendingDetailsFor;
    if (!moduleId || !detailsModel) return;
    await handlers.uninstall(moduleId);
    enterMain();
    await refreshModel();
  } else {
    state.screen = "details";
    state.selectedAction = 0;
  }
}

function currentRow(model: MainScreenModel, selectedRow: number) {
  return model.rows[selectedRow] ?? model.rows[0];
}

function wrapIndex(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
