# The pointer sequences of the controls page, shared by the host script and the headless Edge
# reference. Rows: 1 divs da/db at y 60, 2 buttons ba/bb at y 180, 3 the rebuilt r1 at y 300,
# 4 disabled dis and div dc at y 420, 5 the shadow host sh (s1 in its root at x 40..240, slotted
# l1 at 240..440) at y 540. At width 1280 the right-hand element of a row spans 1060..1260 and
# the left-hand one 660..860; at 1680 they span 1460..1660 and 1060..1260.
# Run it to write controls.json (the host script) and controls-cases.json (for
# tools/edge-ui-controls.mjs).
import json
from pathlib import Path

REPS = 3
CASE_FRAMES = 300


def move(x, y):
    return {'op': 'move', 'x': x, 'y': y}


def down(x, y, button=0):
    return {'op': 'down', 'x': x, 'y': y, 'button': button}


def up(x, y, button=0):
    return {'op': 'up', 'x': x, 'y': y, 'button': button}


def click(x, y, button=0):
    return [move(x, y), down(x, y, button), up(x, y, button)]


# The host waits this many frames; Edge runs one tick and two animation frames.
def hold(frames=30):
    return {'op': 'hold', 'frames': frames}


def resize(width):
    return {'op': 'resize', 'width': width}


CASES = {
    'C-ba': click(1160, 180),
    'C-r1': click(140, 300),
    'P-ba': [move(1160, 180), down(1160, 180), hold(), resize(1680), move(1560, 180), up(1560, 180)],
    'Y-div': [move(1160, 60), down(1160, 60), hold(10), move(960, 60), move(760, 60), hold(10), up(760, 60)],
    # A press on a <button> dragged off it to where nothing is drawn.
    'D-ba': [move(1160, 180), down(1160, 180), hold(10), move(900, 180), move(400, 180), hold(10), up(400, 180)],
    'Y-ba': [move(1160, 180), down(1160, 180), hold(10), move(960, 180), move(760, 180), hold(10), up(760, 180)],
    # A press on ba held still while the window grows and bb moves under the pointer.
    'H-ba': [move(1160, 180), down(1160, 180), hold(), resize(1680), up(1160, 180)],
    # Chords on the divs.
    'K1': [move(1160, 60), down(1160, 60), move(760, 60), down(760, 60, 2), up(760, 60, 2), move(1160, 60), up(1160, 60)],
    'K2': [move(1160, 60), down(1160, 60), down(1160, 60, 2), up(1160, 60, 2), up(1160, 60)],
    'K3': [move(1160, 60), down(1160, 60, 2), down(1160, 60), up(1160, 60), up(1160, 60, 2)],
    'M-db': click(760, 60, 1),
    'R-db': click(760, 60, 2),
    # A press on r1 held while the page rebuilds it, released at the same point.
    'RM-r1': [move(140, 300), down(140, 300), hold(), up(140, 300)],
    # A press on dc released on the disabled button, then a press on the disabled button released
    # on dc, then a click on the disabled button.
    'S1-dc': [move(760, 420), down(760, 420), hold(10), move(1160, 420), hold(10), up(1160, 420)],
    'S2-dis': [move(1160, 420), down(1160, 420), hold(10), move(760, 420), hold(10), up(760, 420)],
    'C-dis': click(1160, 420),
    # A press on s1 in the shadow root dragged onto the slotted light child l1.
    'SH': [move(140, 540), down(140, 540), hold(10), move(340, 540), hold(10), up(340, 540)],
}


def script():
    """The host script and, per press, its case, repeat and first frame."""
    steps, trials, frame = [{'type': 'wait', 'frames': 900}], [], 900
    for rep in range(REPS):
        for name, ops in CASES.items():
            trials.append({'name': name, 'rep': rep, 'start': frame})
            used, resized = 0, False
            for op in ops:
                if op['op'] in ('move', 'down', 'up'):
                    step = {'type': 'pointer', 'action': op['op'], 'x': op['x'], 'y': op['y']}
                    if op['op'] != 'move':
                        step['button'] = op['button']
                    steps.append(step)
                elif op['op'] == 'hold':
                    steps.append({'type': 'wait', 'frames': op['frames']})
                    used += op['frames']
                else:
                    steps.append({'type': 'resize', 'width': op['width'], 'height': 720})
                    steps.append({'type': 'wait', 'frames': 90})
                    used, resized = used + 90, True
            steps.append({'type': 'wait', 'frames': CASE_FRAMES // 2 - used})
            if resized:
                steps.append({'type': 'resize', 'width': 1280, 'height': 720})
            steps.append({'type': 'wait', 'frames': CASE_FRAMES // 2})
            frame += CASE_FRAMES
    steps += [{'type': 'wait', 'frames': 120}, {'type': 'close'}]
    return steps, trials


if __name__ == '__main__':
    here = Path(__file__).parent
    (here / 'controls.json').write_text(json.dumps(script()[0]) + '\n')
    (here / 'controls-cases.json').write_text(json.dumps(CASES, indent=1) + '\n')
