import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const TONE_COLORS: Record<string, number> = {
  core: 0x71d1b9,
  mint: 0x53d79f,
  cyan: 0x29d3dd,
  blue: 0x55a6ff,
  violet: 0xa376ff,
  amber: 0xf4b64b,
  rose: 0xff7f6d
};

const TONE_STRS: Record<string, string> = {
  core: "#71d1b9",
  mint: "#53d79f",
  cyan: "#29d3dd",
  blue: "#55a6ff",
  violet: "#a376ff",
  amber: "#f4b64b",
  rose: "#ff7f6d"
};

function posTo3d(x: number, y: number, zOffset: number): THREE.Vector3 {
  return new THREE.Vector3(
    (x - 50) / 50 * 48,
    -(y - 50) / 50 * 48,
    zOffset
  );
}

function levelZ(level: string): number {
  switch (level) {
    case "core": return 0;
    case "macro": return -8;
    case "meso": return 6;
    case "micro": return 14;
    default: return 0;
  }
}

interface NodeData {
  id: string;
  focusId: string | null;
  label: string;
  subtitle: string;
  tone: string;
  level: string;
  x: number;
  y: number;
  chips: string[];
}

interface LinkData {
  id: string;
  from: string;
  to: string;
  tone: string;
}

interface World3DProps {
  nodes: NodeData[];
  links: LinkData[];
  activeIds: string[];
  focusedId: string | null;
  onNodeClick: (focusId: string | null) => void;
  locale: string;
}

function buildNodeLabel(node: NodeData, focused: boolean, active: boolean, locale: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = [
    "background: linear-gradient(180deg, rgba(8,18,21,0.96), rgba(6,14,17,0.9))",
    "border: 1px solid",
    "border-color: " + (focused ? TONE_STRS[node.tone] || "#71d1b9" : "rgba(255,255,255,0.15)"),
    "border-radius: 18px",
    "padding: 10px 13px",
    "color: #ecf6f2",
    "font-family: 'Trebuchet MS','Segoe UI',sans-serif",
    "font-size: 0.8rem",
    "text-align: left",
    "cursor: pointer",
    "box-shadow: " + (active ? `0 0 20px ${TONE_STRS[node.tone] || "#71d1b9"}44` : "0 4px 12px rgba(0,0,0,0.3)"),
    "pointer-events: auto",
    "user-select: none",
    "backdrop-filter: blur(8px)",
    "min-width: 124px",
    "max-width: 176px",
    "transition: border-color 0.2s, box-shadow 0.2s",
    node.level === "core" ? "min-width: 164px; text-align: center; border-width: 2px;" : ""
  ].filter(Boolean).join(";");

  const title = document.createElement("div");
  title.style.cssText = "font-weight: 700; font-size: 0.9rem; margin-bottom: 2px; color: #ecf6f2;";
  title.textContent = node.label;
  wrapper.appendChild(title);

  const sub = document.createElement("div");
  sub.style.cssText = "color: #9fb7b0; font-size: 0.76rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
  sub.textContent = node.subtitle;
  wrapper.appendChild(sub);

  if (node.chips.length > 0) {
    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;";
    node.chips.forEach((chip) => {
      const c = document.createElement("span");
      c.style.cssText = [
        "display: inline-flex; align-items: center; padding: 0.12rem 0.45rem",
        "border-radius: 999px; border: 1px solid rgba(255,255,255,0.08)",
        "background: rgba(255,255,255,0.04); color: #9fb7b0; font-size: 0.66rem"
      ].join(";");
      c.textContent = chip;
      chipRow.appendChild(c);
    });
    wrapper.appendChild(chipRow);
  }

  return wrapper;
}

export default function World3D({ nodes, links, activeIds, focusedId, onNodeClick, locale }: World3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    renderer: THREE.WebGLRenderer;
    labelRenderer: CSS2DRenderer;
    nodeMap: Map<string, { sphere: THREE.Mesh; label: CSS2DObject }>;
    lineMap: Map<string, THREE.Line>;
    animId: number;
  } | null>(null);

  const handleClick = useCallback((focusId: string | null) => {
    onNodeClick(focusId);
  }, [onNodeClick]);

  // Set up scene once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = Math.max(container.clientHeight, 660);

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 560);
    camera.position.set(0, 9, 88);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.left = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 24;
    controls.maxDistance = 210;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.22;
    controls.target.set(0, -4, 0);

    // Ambient + directional lights
    const ambient = new THREE.AmbientLight(0xffffff, 1.1);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.7);
    dirLight.position.set(10, 20, 30);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x71d1b9, 0.8);
    fillLight.position.set(-15, 5, -10);
    scene.add(fillLight);

    // Starfield
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1050;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
      pos[i] = (Math.random() - 0.5) * 500;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x71d1b9,
      size: 0.25,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });
    scene.add(new THREE.Points(starGeo, starMat));

    // Ground glow
    const glowGeo = new THREE.PlaneGeometry(150, 150);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x71d1b9,
      transparent: true,
      opacity: 0.04,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const glowPlane = new THREE.Mesh(glowGeo, glowMat);
    glowPlane.rotation.x = -Math.PI / 2;
    glowPlane.position.y = -36;
    scene.add(glowPlane);

    // Ring
    const ringGeo = new THREE.RingGeometry(32, 34, 96);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x71d1b9,
      transparent: true,
      opacity: 0.045,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -34;
    scene.add(ring);

    const state = {
      scene, camera, controls, renderer, labelRenderer,
      nodeMap: new Map<string, { sphere: THREE.Mesh; label: CSS2DObject }>(),
      lineMap: new Map<string, THREE.Line>(),
      animId: 0
    };

    function animate() {
      state.animId = requestAnimationFrame(animate);
      state.controls.update();
      state.renderer.render(scene, camera);
      state.labelRenderer.render(scene, camera);
    }
    animate();

    function onResize() {
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 620);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    }
    window.addEventListener("resize", onResize);

    sceneRef.current = state;

    return () => {
      cancelAnimationFrame(state.animId);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      if (container.contains(labelRenderer.domElement)) container.removeChild(labelRenderer.domElement);
      scene.clear();
      sceneRef.current = null;
    };
  }, []);

  // Update nodes and links when data changes
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;

    const { scene, nodeMap, lineMap } = state;
    const activeSet = new Set(activeIds);
    const keepNodes = new Set<string>();
    const keepLines = new Set<string>();

    // --- Nodes ---
    nodes.forEach((node) => {
      keepNodes.add(node.id);
      const pos = posTo3d(node.x, node.y, levelZ(node.level));
      const isCore = node.level === "core";
      const isFocused = node.focusId === focusedId;
      const isActive = activeSet.has(node.id);

      if (nodeMap.has(node.id)) {
        // Update existing
        const entry = nodeMap.get(node.id)!;
        entry.sphere.position.copy(pos);
        const scale = isFocused ? 1.72 : isActive ? 1.34 : isCore ? 1.62 : 0.84;
        entry.sphere.scale.setScalar(scale);
        const mat = entry.sphere.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = isFocused ? 0.95 : isActive ? 0.62 : 0.06;
        entry.label.position.copy(pos);

        const el = entry.label.element as HTMLElement;
        const newEl = buildNodeLabel(node, isFocused, isActive, locale);
        el.innerHTML = newEl.innerHTML;
        el.style.cssText = newEl.style.cssText;
      } else {
        // Create new
        const toneColor = TONE_COLORS[node.tone] || 0x71d1b9;
        const sphereRad = isCore ? 2.7 : 1.28;
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(sphereRad, 20, 20),
          new THREE.MeshStandardMaterial({
            color: toneColor,
            emissive: toneColor,
            emissiveIntensity: isFocused ? 0.95 : isActive ? 0.62 : 0.06,
            metalness: 0.34,
            roughness: 0.36,
            transparent: true,
            opacity: 0.88
          })
        );
        sphere.position.copy(pos);
        sphere.userData.focusId = node.focusId;
        const s = isFocused ? 1.72 : isActive ? 1.34 : isCore ? 1.62 : 1.02;
        sphere.scale.setScalar(s);
        scene.add(sphere);

        // Label
        const labelEl = buildNodeLabel(node, isFocused, isActive, locale);
        const label = new CSS2DObject(labelEl);
        label.position.copy(pos);
        scene.add(label);

        nodeMap.set(node.id, { sphere, label });
      }
    });

    // --- Links ---
    const nodePosMap = new Map<string, THREE.Vector3>();
    nodes.forEach((node) => {
      nodePosMap.set(node.id, posTo3d(node.x, node.y, levelZ(node.level)));
    });

    links.forEach((link) => {
      keepLines.add(link.id);
      const fromPos = nodePosMap.get(link.from);
      const toPos = nodePosMap.get(link.to);
      if (!fromPos || !toPos) return;

      if (lineMap.has(link.id)) {
        const line = lineMap.get(link.id)!;
        const positions = line.geometry.attributes.position.array as Float32Array;
        positions[0] = fromPos.x; positions[1] = fromPos.y; positions[2] = fromPos.z;
        positions[3] = toPos.x; positions[4] = toPos.y; positions[5] = toPos.z;
        line.geometry.attributes.position.needsUpdate = true;
      } else {
        const toneColor = TONE_COLORS[link.tone] || 0x71d1b9;
        const geo = new THREE.BufferGeometry().setFromPoints([fromPos, toPos]);
        const mat = new THREE.LineBasicMaterial({
          color: toneColor,
          transparent: true,
          opacity: 0.35,
          linewidth: 1
        });
        const line = new THREE.Line(geo, mat);
        scene.add(line);
        lineMap.set(link.id, line);
      }
    });

    // --- Remove stale ---
    for (const [id, entry] of nodeMap) {
      if (!keepNodes.has(id)) {
        scene.remove(entry.sphere);
        scene.remove(entry.label);
        nodeMap.delete(id);
      }
    }
    for (const [id, line] of lineMap) {
      if (!keepLines.has(id)) {
        scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
        lineMap.delete(id);
      }
    }
  }, [nodes, links, activeIds, focusedId, locale]);

  // Pulse active nodes
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;

    let phase = 0;
    const interval = setInterval(() => {
      phase += 0.05;
      const pulse = 1 + Math.sin(phase * Math.PI * 2) * 0.15;
      const activeSet = new Set(activeIds);
      for (const [id, entry] of state.nodeMap) {
        if (activeSet.has(id)) {
          const base = (entry.sphere.geometry as THREE.SphereGeometry).parameters.radius;
          entry.sphere.scale.setScalar(base * pulse);
        }
      }
    }, 50);

    return () => clearInterval(interval);
  }, [activeIds]);

  // Update camera lookAt when focused node changes
  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !focusedId) return;

    const node = nodes.find((n) => n.focusId === focusedId);
    if (node) {
      const target = posTo3d(node.x, node.y, levelZ(node.level));
      state.controls.target.copy(target);
      state.controls.update();
    }
  }, [focusedId, nodes]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        minHeight: 660,
        height: "clamp(660px, 76vh, 820px)",
        position: "relative",
        overflow: "hidden",
        borderRadius: "28px",
        cursor: "grab"
      }}
      onMouseDown={(e) => {
        const state = sceneRef.current;
        if (!state) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2(x, y);
        raycaster.setFromCamera(mouse, state.camera);
        const meshes: THREE.Object3D[] = [];
        for (const [, entry] of state.nodeMap) {
          meshes.push(entry.sphere);
        }
        const hits = raycaster.intersectObjects(meshes);
        if (hits.length > 0) {
          const hit = hits[0].object as THREE.Mesh;
          const focusId = hit.userData.focusId as string | undefined;
          handleClick(focusId ?? null);
        }
      }}
      aria-label={locale === "zh-CN" ? "3D 代码世界" : "3D code world"}
    />
  );
}
