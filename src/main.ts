import { Engine } from "./core/Engine";
import { GameScene } from "./scenes/GameScene";
import "./styles.css";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const engine = new Engine(
  canvas,
  {
    GAME: new GameScene(),
  },
  { initialScene: "GAME" },
);

engine.getSceneManager().onSceneChange((prev, next) => {
  console.log(`[App] SCENE: ${prev} → ${next}`);
});

await engine.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    engine.dispose();
  });
}
