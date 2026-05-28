import * as THREE from "three";

export class CameraFollowComponent {
  constructor(
    public offset: THREE.Vector3,
    public smoothing: number,
  ) {}
}
