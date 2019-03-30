const warn = AFRAME.utils.debug("puzzle-3d:warn");
const radToDeg = THREE.Math.radToDeg
const degToRad = THREE.Math.degToRad
const angleBetween = (quatA, quatB) => 2 * Math.acos( Math.abs( THREE.Math.clamp( quatA.dot( quatB ), - 1, 1 ) ) )

/******************************************************************************
 * puzzle-3d AFrame System
 */
AFRAME.registerSystem("puzzle-3d", {
  schema: {
    // TODO ghost may need some of these values
    // goalRotation: {
    //   type: "vec3"
    // },
    // goalPosition: {
    //   type: "vec3"
    // },
    // goalMixin: {
    //   default: ""
    // },
    // positionTolerance: {
    //   default: 0.05
    // },
    // angleTolerance: {
    //   default: 20
    // }
  },

  init() {
    this.pieces = new Map()
    this.alternatives = new Map()
    this.goals = new Map() // for each object being manipulated
    this.goalPosition = new THREE.Vector3()
    this.goalQuaternion = new THREE.Quaternion()
  },

  update() {
    const data = this.data
    this.goalPosition.copy(data.goalPosition)
    this.goalQuaternion.setFromEuler(new THREE.Euler(degToRad(data.goalRotation.x), degToRad(data.goalRotation.y), degToRad(data.goalRotation.z), "YXZ"))
  },

  // TODO we should only be able to snap to ourselves during registerPiece()
  registerPiece(obj3D, ghostEl, goalPosition, goalQuaternion, positionTolerance, angleTolerance) {
    // goalPosition = goalPosition || this.goalPosition
    // goalQuaternion = goalQuaternion || this.goalQuaternion
    // positionTolerance = positionTolerance || this.data.positionTolerance
    // angleTolerance = angleTolerance || this.data.angleTolerance

    this.pieces.set(obj3D, { 
      position: new THREE.Vector3().copy(goalPosition), 
      quaternion: new THREE.Quaternion().copy(goalQuaternion), 
      ghostEl,
      positionTolerance,
      angleTolerance,
      snapObj3D: undefined,
    })

  },

  unregisterPiece(obj3D) {
    this.pieces.delete(obj3D)
  },

  registerAlternatives(obj3D, altObj3Ds) {
    // position and quaternion will be calculated later as the object may not be loaded yet
    this.alternatives.set(obj3D, altObj3Ds.map(obj3D => ({ obj3D, position: undefined, quaternion: undefined }) ))
  },

  setupGoals(obj3D, handObj3D) {
    this.goals.set(obj3D, this.generateGoals(obj3D, handObj3D))
  },

  forceSnapPiece(obj3D) {
    let piece = this.pieces.get(obj3D)
    if (piece) {
      piece.snapObj3D = obj3D
      piece.ghostEl.object3D.visible = false
      obj3D.position.copy(piece.position)
      obj3D.quaternion.copy(piece.quaternion)
    } else {
      warn("attempting to force snap an unregistered piece")
    }
  },

  // snaps into either the place registered for obj3D or an alternative registered for obj3D
  // will hide the ghostEl on a successful snap
  trySnapPiece(obj3D, handObj3D) {
    let goals = this.goals.get(obj3D)
    if (!goals) {
      return false
    }
    
    let snappedGoal = undefined

    for (let i = 0; i < goals.length; i++) {
      const goal = goals[i]
      const distance = handObj3D.position.distanceTo(goal.handPosition)
      const angle = radToDeg( angleBetween(handObj3D.quaternion,goal.handQuaternion) )

      // console.log(distance, angle)

      if (distance < goal.positionTolerance && angle < goal.angleTolerance) {
        snappedGoal = goal
        break
      }
    }

    let piece = this.pieces.get(obj3D)
    if (snappedGoal && piece.snapObj3D !== snappedGoal.obj3D) {
      if (piece.snapObj3D) {
        this.pieces.get(piece.snapObj3D).ghostEl.object3D.visible = true
      }
      this.pieces.get(snappedGoal.obj3D).ghostEl.object3D.visible = false
      piece.snapObj3D = snappedGoal.obj3D
      obj3D.position.copy(snappedGoal.position)
      obj3D.quaternion.copy(snappedGoal.quaternion)

    } else if (!snappedGoal && piece.snapObj3D) {
      this.pieces.get(piece.snapObj3D).ghostEl.object3D.visible = true
      piece.snapObj3D = undefined

    }

    return snappedGoal !== undefined
  },

  generateGoals: (function () {
    let tempScale = new THREE.Vector3()
    let tempPosition = new THREE.Vector3()
    let tempQuaternion = new THREE.Quaternion() 
  
    // this function is expensive for complicated models
    function centroidAndCenterFromObject3D(obj3D, outCenter, outCentroid) {
      let v1 = new THREE.Vector3()
      let box3 = new THREE.Box3()
      let numPoints = 0

      function traverse(node) {
        const geometry = node.geometry
        if (geometry && geometry.isBufferGeometry) {
          const attribute = geometry.attributes.position
          if (attribute && attribute.itemSize >= 3) {
            for (let i = 0, n = attribute.count; i < n; i++) {
              v1.fromBufferAttribute(attribute, i).applyMatrix4(node.matrixWorld)
              box3.expandByPoint(v1)
              outCentroid.add(v1)
              numPoints++
            }
          }
        }
      }

      outCentroid.set(0,0,0)
      outCenter.set(0,0,0)

      tempPosition.copy(obj3D.position)
      tempQuaternion.copy(obj3D.quaternion)
      tempScale.copy(obj3D.scale)

      // set thee object matrix to identity, this is to ensure that the bounding box
      // and centroid are aligned to the object
      obj3D.position.set(0,0,0)
      obj3D.quaternion.set(0,0,0,1)
      obj3D.scale.set(1,1,1)
      obj3D.updateMatrixWorld(true)

      obj3D.traverse(traverse)

      obj3D.position.copy(tempPosition)
      obj3D.quaternion.copy(tempQuaternion)
      obj3D.scale.copy(tempScale)
      obj3D.updateMatrixWorld(true)

      if (numPoints > 0) {
        outCentroid.multiplyScalar(1/numPoints)
      }
      if (!box3.isEmpty()) {
        outCenter.subVectors(box3.max, box3.min).multiplyScalar(0.5).add(box3.min)
      }

      return numPoints > 0
    }

    let handOffsetMatrix = new THREE.Matrix4()
    let handGoalMatrix = new THREE.Matrix4()

    // put the hand matrix into object space, then map that onto the goal space to determine the 
    // hand position when we are at the goal
    function calcGoalHandPosition(obj3D, handObj3D, goalPosition, goalQuaternion, outPosition, outQuaternion) {
      handOffsetMatrix.getInverse(obj3D.matrixWorld).multiply(handObj3D.matrixWorld)
      handGoalMatrix.compose(goalPosition, goalQuaternion, obj3D.scale).multiply(handOffsetMatrix)
      handGoalMatrix.decompose(outPosition, outQuaternion, tempScale)

      // {
      //   let axes = new THREE.AxesHelper(0.1)
      //   axes.applyMatrix(handGoalMatrix)
      //   obj3D.el.sceneEl.object3D.add(axes)
      // }
    }

    let centroidOffsetMatrix = new THREE.Matrix4()
    let offsetMatrix = new THREE.Matrix4()
    let goalMatrix = new THREE.Matrix4()
    let altMatrix = new THREE.Matrix4()
    let objMatrix = new THREE.Matrix4() 
    let altCenter = new THREE.Vector3()
    let altCentroid = new THREE.Vector3()
    let objCenter = new THREE.Vector3()
    let objCentroid = new THREE.Vector3()
    let tempUp = new THREE.Vector3()

    // this function is expensive, it iterates over all vertices in the object
    function calcAlternateGoal(obj3D, altObj3D, altGoalPosition, altGoalQuaternion, outPosition, outQuaternion) {
      // check the alt first, as it may not be loaded
      if (!centroidAndCenterFromObject3D(altObj3D, altCenter, altCentroid)) {
        return false
      }
      if (!centroidAndCenterFromObject3D(obj3D, objCenter, objCentroid)) {
        return false
      }

      // WARNING
      // we assume obj3D and altObj3D are approximately the same mesh, so
      // center to centroid is an approximate direction vector for the mesh, 
      // but there may be some rounding error in the calculation or small 
      // differences in the mesh

      // map the centers and centroids back into world space
      altCenter.applyMatrix4(altObj3D.matrixWorld)
      altCentroid.applyMatrix4(altObj3D.matrixWorld)
      objCenter.applyMatrix4(obj3D.matrixWorld)
      objCentroid.applyMatrix4(obj3D.matrixWorld)

      // determine the matrices for the geometry of the obj and alt pieces. we use
      // these matrices to determine the facing direction of the pieces
      tempUp.setFromMatrixColumn( altObj3D.matrixWorld, 1 )
      altMatrix.lookAt(altCenter, altCentroid, tempUp).setPosition(altCenter)
      tempUp.setFromMatrixColumn( obj3D.matrixWorld, 1 )
      objMatrix.lookAt(objCenter, objCentroid, tempUp).setPosition(objCenter)

      // map the obj3D origin onto the objMatrix centroid, then map that onto the altMatrix centroid,
      // then map that onto the altObj3D origin and finally onto the altGoal. This will give
      // us the goal position for our object if it was placed at the altObj's position
      centroidOffsetMatrix.getInverse(objMatrix).multiply(obj3D.matrixWorld)
      offsetMatrix.getInverse(altObj3D.matrixWorld).multiply(altMatrix).multiply(centroidOffsetMatrix)
      goalMatrix.compose(altGoalPosition, altGoalQuaternion, altObj3D.scale).multiply(offsetMatrix)
      goalMatrix.decompose(outPosition, outQuaternion, tempScale)

      // {
      //   let axes = new THREE.AxesHelper(0.1)
      //   axes.applyMatrix(objMatrix)
      //   obj3D.el.sceneEl.object3D.add(axes)
      // }
      // {
      //   let axes = new THREE.AxesHelper(0.1)
      //   axes.applyMatrix(altMatrix)
      //   obj3D.el.sceneEl.object3D.add(axes)
      // }

      return true
    }    

    let handPosition = new THREE.Vector3()
    let handQuaternion = new THREE.Quaternion()
    
    return function generateGoals(obj3D, handObj3D) {
      let piece = this.pieces.get(obj3D)
      let goals = []

      calcGoalHandPosition(obj3D, handObj3D, piece.position, piece.quaternion, handPosition, handQuaternion)

      goals.push({
        position: piece.position,
        quaternion: piece.quaternion,
        handPosition: new THREE.Vector3().copy(handPosition),
        handQuaternion: new THREE.Quaternion().copy(handQuaternion),
        positionTolerance: piece.positionTolerance,
        angleTolerance: piece.angleTolerance,
        obj3D: obj3D,
      })
  
      let alts = this.alternatives.get(obj3D)
      for (let alt of alts) {
        const altPiece = this.pieces.get(alt.obj3D)
        if (!altPiece) continue

        // if (!alt.position || !alt.quaternion) {
        {
          if (calcAlternateGoal(obj3D, alt.obj3D, altPiece.position, altPiece.quaternion, tempPosition, tempQuaternion)) {
            alt.position = new THREE.Vector3().copy(tempPosition)
            alt.quaternion = new THREE.Quaternion().copy(tempQuaternion)
          }
        }

        if (alt.position && alt.quaternion) {
          calcGoalHandPosition(obj3D, handObj3D, alt.position, alt.quaternion, handPosition, handQuaternion)

          goals.push({
            position: new THREE.Vector3().copy(alt.position),
            quaternion: new THREE.Quaternion().copy(alt.quaternion),
            handPosition: new THREE.Vector3().copy(handPosition),
            handQuaternion: new THREE.Quaternion().copy(handQuaternion),
            positionTolerance: altPiece.positionTolerance,
            angleTolerance: altPiece.angleTolerance,
            obj3D: alt.obj3D,
          })
        }
      }
  
      return goals
    }
  })(),
})

/******************************************************************************
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
    alternatives: {
      type: "string"
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
    this.alternativeObjs = []

    this.el.addEventListener("grabstart", this.onGrabStart.bind(this))
    this.el.addEventListener("grabend", this.onGrabEnd.bind(this))
  },

  remove() {
    this.system.unregisterPiece(obj3D)
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

    if (oldData.alternatives !== data.alternatives) {
      this.alternativeObjs = data.alternatives.split(",").map(str => str ? document.querySelector(str.trim()) : undefined).map(x => x ? x.object3D : undefined).filter(x => x)
    }

    const obj3D = this.el.object3D
    this.system.registerPiece(obj3D, this.ghostEl, this.goalPosition, this.goalQuaternion, data.positionTolerance, data.angleTolerance)
    this.system.registerAlternatives(obj3D, this.alternativeObjs)

    // possibly snap into place on startup
    if (obj3D &&
        obj3D.position.distanceTo(this.goalPosition) < data.positionTolerance &&
        angleBetween(obj3D.quaternion, this.goalQuaternion) < data.angleTolerance) {
      this.setState("snap")
      this.system.forceSnapPiece(obj3D)
    }

  },

  tick() {
    if (this.grabHand) {
      const obj3D = this.el.object3D
      const handObj3D = this.grabHand.object3D

      if (this.system.trySnapPiece(obj3D, handObj3D)) {
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
  },

  enterState(to) {
    if (to === "snap") {
      this.el.emit("puzzlesnap", {}, true)
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

  setupSnap(handObj3D) {
    const obj3D = this.el.object3D
    this.grabMatrix.getInverse(handObj3D.matrixWorld).multiply(obj3D.matrix)
    this.system.setupGoals(obj3D, handObj3D)
  },

})
