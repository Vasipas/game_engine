import type { InputManager } from "../core/InputManager";

export type TSceneKeys = "GAME" | "MENU";

export type SceneContext = {
  switchScene: (key: TSceneKeys) => void;
  input: InputManager;
};
