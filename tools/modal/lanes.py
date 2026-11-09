from pathlib import Path
import subprocess

import modal

ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/src")
image = (
    modal.Image.debian_slim()
    .apt_install("build-essential", "ca-certificates", "curl", "libvulkan1", "mesa-vulkan-drivers")
    .run_commands("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal")
    .env({"PATH": "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "VK_ICD_FILENAMES": "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json"})
    .add_local_file(ROOT / "Cargo.toml", "/src/Cargo.toml")
    .add_local_file(ROOT / "Cargo.lock", "/src/Cargo.lock")
    .add_local_dir(ROOT / "crates", "/src/crates")
)
app = modal.App("threejsc-e3")


@app.function(image=image, cpu=2, memory=4096, timeout=1200)
def gpu_replay():
    subprocess.run(["cargo", "test", "-p", "threejsc-gpu", "--locked", "--test", "replay", "--", "--ignored", "--nocapture"], cwd="/src", check=True)
