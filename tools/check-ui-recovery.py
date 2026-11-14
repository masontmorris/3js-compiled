import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))[sys.argv[2]]
assert result['hud_visible_before_kill'] and result['pass_interval_50ms']
assert result['pass_return_within_1s'], result['hud_return_after_kill_ms_wall']
print(f"HUD returned in {result['hud_return_after_kill_ms_wall']} ms")
