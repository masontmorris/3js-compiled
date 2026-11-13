from pathlib import Path
import subprocess

import modal

ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/src")
PATH = "/root/.cargo/bin:/opt/node/bin:/opt/dxc/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RUSTUP = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
replay_image = (
    modal.Image.debian_slim()
    .apt_install("build-essential", "ca-certificates", "curl", "libvulkan1", "mesa-vulkan-drivers")
    .run_commands(RUSTUP)
    .env({"PATH": PATH, "VK_ICD_FILENAMES": "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json"})
    .add_local_file(ROOT / "Cargo.toml", "/src/Cargo.toml")
    .add_local_file(ROOT / "Cargo.lock", "/src/Cargo.lock")
    .add_local_file(ROOT / "rust-toolchain.toml", "/src/rust-toolchain.toml")
    .add_local_dir(ROOT / "crates", "/src/crates")
    .add_local_dir(ROOT / "third_party", "/src/third_party")
    .add_local_dir(ROOT / "examples" / "audio" / "clips", "/src/examples/audio/clips")
)
# The Linux DXC release needs glibc 2.38, which Debian bookworm lacks.
gate_image = (
    modal.Image.from_registry("debian:trixie-slim", add_python="3.12")
    .apt_install("build-essential", "ca-certificates", "curl", "git", "xz-utils")
    .run_commands(RUSTUP)
    .env({"PATH": PATH, "LD_LIBRARY_PATH": "/opt/dxc/lib"})
    .run_commands(
        "cargo install naga-cli --version 30.0.1 --locked",
        "mkdir -p /opt/node && curl -sSfL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz | tar -xJ --strip-components=1 -C /opt/node",
        "mkdir -p /opt/dxc && curl -sSfL https://github.com/microsoft/DirectXShaderCompiler/releases/download/v1.9.2609/linux_dxc_2026_09_28.x86_x64.tar.gz | tar -xz -C /opt/dxc",
    )
    .add_local_file(ROOT / "package.json", "/src/package.json", copy=True)
    .add_local_file(ROOT / "package-lock.json", "/src/package-lock.json", copy=True)
    .add_local_dir(ROOT / "packages", "/src/packages", copy=True, ignore=["**/node_modules"])
    .add_local_dir(ROOT / "tools", "/src/tools", copy=True, ignore=["**/__pycache__"])
    .run_commands("cd /src && npm ci --no-audit --no-fund")
    .add_local_dir(ROOT / "examples", "/src/examples", ignore=["**/scene-bundle.js", "**/platform-bundle.js"])
)
app = modal.App("threejsc-e3")


@app.function(image=replay_image, cpu=2, memory=4096, timeout=1200)
def gpu_replay():
    subprocess.run(["cargo", "test", "-p", "threejsc-gpu", "--locked", "--lib", "--test", "replay", "--", "--ignored", "--nocapture"], cwd="/src", check=True)


@app.function(image=gate_image, cpu=2, memory=4096, timeout=1200)
def js_tests():
    subprocess.run(["npm", "test", "-w", "packages/three-native"], cwd="/src", check=True)


@app.function(image=gate_image, cpu=2, memory=4096, timeout=1200)
def wgsl_gate():
    subprocess.run(["dxc", "--version"], check=True)
    subprocess.run(["node", "tools/wgsl-gate/gate.mjs", "/tmp/wgsl-gate"], cwd="/src", check=True)


@app.function(image=replay_image, cpu=2, memory=4096, timeout=1200)
def audio_offline():
    subprocess.run(["cargo", "test", "-p", "threejsc-audio", "--release", "--locked", "--", "--nocapture"], cwd="/src", check=True)
