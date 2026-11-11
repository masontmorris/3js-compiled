use threejsc_host::script::{PointerAction, Step, parse};

#[test]
fn parses_each_step_and_rejects_unknown_types() {
    let steps = parse(
        r#"[
      {"type":"wait","frames":2},
      {"type":"key","code":"KeyW","down":true},
      {"type":"pointer","action":"move","x":100.0,"y":100.0},
      {"type":"wheel","x":0.0,"y":1.0},
      {"type":"gamepad","button":0,"down":true},
      {"type":"resize","width":1280,"height":720},
      {"type":"capture","path":"capture.png"},
      {"type":"close"}
    ]"#,
    )
    .unwrap();
    assert_eq!(steps.len(), 8);
    assert!(matches!(steps[0], Step::Wait { frames: 2 }));
    assert!(matches!(&steps[1], Step::Key { code, down: true, repeat: false } if code == "KeyW"));
    assert!(matches!(
        steps[2],
        Step::Pointer {
            action: PointerAction::Move,
            x: 100.0,
            y: 100.0,
            ..
        }
    ));
    assert!(matches!(steps[3], Step::Wheel { y: 1.0, .. }));
    assert!(matches!(
        steps[4],
        Step::Gamepad {
            button: 0,
            down: true,
            ..
        }
    ));
    assert!(matches!(
        steps[5],
        Step::Resize {
            width: 1280,
            height: 720
        }
    ));
    assert!(matches!(&steps[6], Step::Capture { path } if path.to_string_lossy() == "capture.png"));
    assert!(matches!(steps[7], Step::Close));
    assert!(parse(r#"[{"type":"unknown"}]"#).is_err());
}
