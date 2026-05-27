import * as THREE from "three";

export class FloorFactory {
  static create(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(20, 20);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      roughness: 0.8,
    });
    const floor = new THREE.Mesh(geo, mat);
    floor.receiveShadow = true;
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
  }
}
