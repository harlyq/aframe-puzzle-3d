const warn = AFRAME.utils.debug("puzzle-3d:warn");
const radToDeg = THREE.Math.radToDeg
const degToRad = THREE.Math.degToRad

/**
 * puzzle-3d AFrame Component
 */
AFRAME.registerComponent("puzzle-3d", {
  schema: {
    goalRotation: {
      type: "vec3"
    },
    goalPosition: {
      type: "vec3"
    },
    goalMixin: {
      default: ""
    },
    positionTolerance: {
      default: 0.05
    },
    angleTolerance: {
      default: 20
    }
  },

  multiple: true,

  init() {
    this.state = "free"
    this.grabHand = undefined
    this.grabMatrix = new THREE.Matrix4() // object matrix relative to the hand axis
    this.goalPosition = new THREE.Vector3()
    this.goalQuaternion = new THREE.Quaternion()
    this.goalHandPosition = new THREE.Vector3()
    this.goalHandQuaternion = new THREE.Quaternion()
    this.goalRefObj3D = undefined
    this.ghostEntity = undefined

    this.el.addEventListener("grabstart", this.onGrabStart.bind(this))
    this.el.addEventListener("grabend", this.onGrabEnd.bind(this))
  },

  remove() {
    this.el.sceneEl.removeChild(this.ghostEl)
  },

  update(oldData) {
    const data = this.data

    if (oldData.goalMixin !== data.goalMixin) {
      this.setupGhost(data.goalMixin)
    }

    if (oldData.goalPosition !== data.goalPosition) {
      if (this.ghostEl) {
        this.ghostEl.setAttribute("position", AFRAME.utils.coordinates.stringify(data.goalPosition))
      }
      this.goalPosition.copy(data.goalPosition)
    }

    if (oldData.goalRotation !== data.goalRotation) {
      if (this.ghostEl) {
        this.ghostEl.setAttribute("rotation", AFRAME.utils.coordinates.stringify(data.goalRotation))
      }
      this.goalQuaternion.setFromEuler(new THREE.Euler(degToRad(data.goalRotation.x), degToRad(data.goalRotation.y), degToRad(data.goalRotation.z), "YXZ"))
    }

    // possibly snap into place on startup
    const obj3D = this.el.object3D
    if (obj3D &&
        obj3D.position.distanceTo(this.goalPosition) < data.positionTolerance &&
        obj3D.quaternion.angleTo(this.goalQuaternion) < data.angleTolerance) {
      this.setState("snap")
    }
  },

  tick() {
    if (this.grabHand) {
      const data = this.data
      const obj3D = this.el.object3D
      const handObj3D = this.grabHand.object3D

      const distance = handObj3D.position.distanceTo(this.goalHandPosition)
      const angle = radToDeg(handObj3D.quaternion.angleTo(this.goalHandQuaternion))

      // console.log(distance, angle)
      if (distance < data.positionTolerance && angle < data.angleTolerance) {
        this.setState("snap")
      } else {
        this.setState("free")
      }

      if (this.state === "free") {
        // TODO make this work when parented to something
        obj3D.matrix.multiplyMatrices(handObj3D.matrixWorld, this.grabMatrix)
        obj3D.matrix.decompose(obj3D.position, obj3D.quaternion, obj3D.scale)
      }
    }
  },

  setState(s) {
    if (this.state !== s) {
      this.leaveState(this.state, s)
      this.enterState(s, this.state)
      this.state = s
      console.log("state", s)
    }
  },

  leaveState(from) {
    if (from === "snap") {
      this.ghostEl.object3D.visible = true
    }
  },

  enterState(to) {
    if (to === "snap") {
      this.el.emit("puzzlesnap", {}, true)
      const obj3D = this.el.object3D
      obj3D.position.copy(this.goalPosition)
      obj3D.quaternion.copy(this.goalQuaternion)
      this.ghostEl.object3D.visible = false

    } else if (to === "free") {
      this.el.emit("puzzlefree", {}, true)
    }
  },

  onGrabStart(e) {
    // console.log("puzzle3d grabstart", e.detail.hand.id)
    this.grabHand = e.detail.hand
    this.setupSnap(this.grabHand.object3D)
  },

  onGrabEnd(e) {
    // console.log("puzzle3d end", e.detail.hand.id)
    if (e.detail.hand === this.grabHand) {
      this.grabHand = undefined
    }
  },

  setupGhost(ghostMixin) {
    if (this.ghostEl) {
      this.el.sceneEl.removeChild(ghostEntity)
      this.ghostEl = undefined
    }

    if (ghostMixin) {
      let ghostEntity = document.createElement("a-entity")

      this.el.sceneEl.appendChild(ghostEntity)
      if (this.el.id) {
        ghostEntity.setAttribute("id", "goal-" + this.el.id)
      }
      this.ghostEl = ghostEntity
  
      this.el.addEventListener("object3dset", (e) => {
        if (e.target === this.el && e.detail.type) {
          this.ghostEl.setObject3D(e.detail.type, this.el.getObject3D(e.detail.type).clone())
        }
      })
  
      this.el.addEventListener("object3dremove", (e) => {
        if (e.target === this.el && e.detail.type) {
          this.ghostEl.removeObject3D(e.detail.type)
        }
      })
  
      if (this.el.object3D) {
        this.el.object3D.children.forEach(part => this.ghostEl.object3D.add(part.clone))
        this.ghostEl.object3DMap = this.el.object3DMap
      }
  
      this.ghostEl.setAttribute("scale", this.el.getAttribute("scale"))
      this.ghostEl.setAttribute("mixin", ghostMixin)    
    }
  },

  setupSnap: (function () {
    let handOffsetMatrix = new THREE.Matrix4()
    let handGoalMatrix = new THREE.Matrix4()
    let tempScale = new THREE.Vector3()

    return function setupSnap(handObj3D) {
      const obj3D = this.el.object3D
      this.grabMatrix.getInverse(handObj3D.matrixWorld).multiply(obj3D.matrix)
  
      // put the hand matrix into object space, then map that onto the goal space to determine the 
      // hand position when we are at the goal
      handOffsetMatrix.getInverse(obj3D.matrixWorld).multiply(handObj3D.matrixWorld)
      handGoalMatrix.compose(this.goalPosition, this.goalQuaternion, obj3D.scale).multiply(handOffsetMatrix)
      handGoalMatrix.decompose(this.goalHandPosition, this.goalHandQuaternion, tempScale)
    
      // {
      //   let axes = new THREE.AxesHelper(0.1)
      //   axes.applyMatrix(handGoalMatrix)
      //   obj3D.el.sceneEl.object3D.add(axes)
      // }
    }
  
  })(),

})
