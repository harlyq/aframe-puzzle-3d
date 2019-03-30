const warn = AFRAME.utils.debug("puzzle-3d:warn");
const radToDeg = THREE.Math.radToDeg
const degToRad = THREE.Math.degToRad

/**
 * puzzle-3d AFrame Component
 */
AFRAME.registerComponent("puzzle-3d", {
  schema: {
    goalRotations: {
      type: "string"
    },
    goalPositions: {
      type: "string"
    },
    goalMixin: {
      default: ""
    },
    positionTolerance: {
      default: 0.05
    },
    angleTolerance: {
      default: 20
    },
    snapIndex: {
      type: "int",
      default: -1
    }
  },

  multiple: true,

  init() {
    this.state = { name: "free" }
    this.grabHand = undefined
    this.grabMatrix = new THREE.Matrix4() // object matrix relative to the hand axis
    this.goalPositions = []
    this.goalQuaternions = []
    this.goalHandPositions = []
    this.goalHandQuaternions = []
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

    if (oldData.goalPositions !== data.goalPositions) {
      const positionStrs = data.goalPositions.split(",")
      this.goalPositions = positionStrs.
        filter(str => str.trim()).
        map(str => AFRAME.utils.coordinates.parse(str)).
        map(vec => new THREE.Vector3().copy(vec))
  
      if (this.ghostEl) {
        this.ghostEl.setAttribute("position", positionStrs[0])
      }
    }

    if (oldData.goalRotations !== data.goalRotations) {
      const rotationStrs = data.goalRotations.split(",")
      const euler = new THREE.Euler()
      this.goalQuaternions = rotationStrs.
        filter(str => str.trim()).
        map(str => AFRAME.utils.coordinates.parse(str)).
        map(vec => new THREE.Quaternion().setFromEuler( euler.set(degToRad(vec.x), degToRad(vec.y), degToRad(vec.z), "YXZ") ))

      if (this.ghostEl) {
        this.ghostEl.setAttribute("rotation", rotationStrs[0])
      }
    }

    // possibly snap into place on startup
    if (oldData.snapIndex !== data.snapIndex && data.snapIndex >= 0 && data.snapIndex < this.goalPositions.length && data.snapIndex < this.goalQuaternions.length) {
      this.setState({ name: "snap", value: data.snapIndex })
    }
  },

  tick() {
    if (this.grabHand) {
      const data = this.data
      const obj3D = this.el.object3D
      const handObj3D = this.grabHand.object3D

      let snapIndex = -1
      for (let i = 0; i < this.goalHandPositions.length; i++) {
        const distance = handObj3D.position.distanceTo(this.goalHandPositions[i])
        const angle = radToDeg(handObj3D.quaternion.angleTo(this.goalHandQuaternions[i]))
  
        // console.log(distance, angle)
        if (distance < data.positionTolerance && angle < data.angleTolerance) {
          snapIndex = i
          break
        } 
      }

      if (snapIndex !== -1) {
        this.setState({ name: "snap", value: snapIndex })
      } else {
        this.setState({ name: "free" })
        // TODO make this work when parented to something
        obj3D.matrix.multiplyMatrices(handObj3D.matrixWorld, this.grabMatrix)
        obj3D.matrix.decompose(obj3D.position, obj3D.quaternion, obj3D.scale)
      }
    }
  },

  setState(s) {
    if (this.state.name !== s.name || this.state.value !== s.value) {
      this.leaveState(this.state, s)
      this.enterState(s, this.state)
      this.state = s
      console.log("state", s)
    }
  },

  leaveState(from) {
    if (from.name === "snap" && from.value === 0) {
      this.ghostEl.object3D.visible = true
    }
  },

  enterState(to) {
    if (to.name === "snap") {
      this.el.emit("puzzlesnap", {value: to.value}, true)
      const obj3D = this.el.object3D
      obj3D.position.copy(this.goalPositions[to.value])
      obj3D.quaternion.copy(this.goalQuaternions[to.value])

      // the ghost is only relative to the 0th goalPosition
      if (to.value === 0) {
        this.ghostEl.object3D.visible = false
      } else {
        this.ghostEl.object3D.visible = true
      }

    } else if (to.name === "free") {
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

    function calcGoalHandMatrix(obj3D, handObj3D, goalPosition, goalQuaternion, outPosition, outQuaternion) {
      // put the hand matrix into object space, then map that onto the goal space to determine the 
      // hand position when we are at the goal
      handOffsetMatrix.getInverse(obj3D.matrixWorld).multiply(handObj3D.matrixWorld)
      handGoalMatrix.compose(goalPosition, goalQuaternion, obj3D.scale).multiply(handOffsetMatrix)
      handGoalMatrix.decompose(outPosition, outQuaternion, tempScale)

      // {
      //   let axes = new THREE.AxesHelper(0.1)
      //   axes.applyMatrix(handGoalMatrix)
      //   obj3D.el.sceneEl.object3D.add(axes)
      // }
    }

    let tempPosition = new THREE.Vector3()
    let tempQuaternion = new THREE.Quaternion()

    return function setupSnap(handObj3D) {
      const obj3D = this.el.object3D
      this.grabMatrix.getInverse(handObj3D.matrixWorld).multiply(obj3D.matrix)
  
      const n = Math.min(this.goalPositions.length, this.goalQuaternions.length)
      this.goalHandPositions.length = 0
      this.goalHandQuaternions.length = 0

      for (let i = 0; i < n; i++) {
        calcGoalHandMatrix(obj3D, handObj3D, this.goalPositions[i], this.goalQuaternions[i], tempPosition, tempQuaternion)
        this.goalHandPositions.push(new THREE.Vector3().copy(tempPosition))
        this.goalHandQuaternions.push(new THREE.Quaternion().copy(tempQuaternion))
      }
    }
  
  })(),

})
