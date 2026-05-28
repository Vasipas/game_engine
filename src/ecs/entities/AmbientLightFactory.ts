import * as THREE from "three";

export class AmbientLightFactory {
  static create(scene: THREE.Scene) {
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
  }
}
