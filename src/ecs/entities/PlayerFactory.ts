import * as THREE from "three";
import type { World } from "../World";
import { PositionComponent } from "../components/PositionComponent";
import { VelocityComponent } from "../components/VelocityComponent";
import { MeshComponent } from "../components/MeshComponent";

export class PlayerFactory {
  static create(world: World, scene: THREE.Scene) {
    const entity = world.addEntity();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 32, 32),
      new THREE.MeshStandardMaterial({
        color: 0x7c3aed,
        metalness: 0.8,
        roughness: 0.1,
      }),
    );
    scene.add(mesh);

    world.addComponent(entity, new PositionComponent(0, 1, 0));
    world.addComponent(entity, new VelocityComponent());
    world.addComponent(entity, new MeshComponent(mesh));

    return entity;
  }
}
