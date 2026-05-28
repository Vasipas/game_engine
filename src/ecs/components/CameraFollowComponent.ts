import * as THREE from "three";

export class CameraFollowComponent {
  constructor(
    public camera: THREE.Camera,
    public target: number,
    public offset: THREE.Vector3,
    public smoothing: number,
  ) {}
}
