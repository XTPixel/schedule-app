//! QA 边界/异常输入探针（用于 bug 取证，不参与 cargo test）。
//! 运行：cargo run -p schedule-core --example qa_probe

use chrono::{Duration, NaiveDate, TimeZone, Utc};
use schedule_core::{
    compute_candidates, parse_natural_language, search, time_window_matches_date, timeutil,
    AppData, ArchiveFile, ArchiveSource, Config, Event, ItemStatus, Priority, Repeat, Routine,
    SearchQuery, Storage, Task, TimeWindow,
};
use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;

fn base_data(events: Vec<Event>, routines: Vec<Routine>, tasks: Vec<Task>) -> AppData {
    AppData {
        events,
        routines,
        tasks,
        long_tasks: vec![],
        config: Config::default(),
        archive: ArchiveFile {
            version: schedule_core::CURRENT_VERSION,
            month: "2025-01".to_string(),
            days: Default::default(),
        },
    }
}

fn event_at(id: &str, start: &str, repeat: Option<Repeat>) -> Event {
    Event {
        id: id.to_string(),
        title: "E".to_string(),
        description: None,
        start: start.to_string(),
        end: None,
        all_day: false,
        reminders: vec![],
        repeat,
        tags: vec![],
        priority: Priority::Normal,
        status: ItemStatus::Active,
        created_at: String::new(),
        updated_at: String::new(),
        completed_at: None,
        deleted_at: None,
    }
}

fn task_at(id: &str, deadline: &str) -> Task {
    Task {
        id: id.to_string(),
        title: "T".to_string(),
        description: None,
        priority: Priority::Normal,
        deadline: Some(deadline.to_string()),
        tags: vec![],
        status: ItemStatus::Active,
        sort_order: 0,
        created_at: String::new(),
        updated_at: String::new(),
        completed_at: None,
        deleted_at: None,
    }
}

fn main() {
    // ------------------------------------------------------------------
    // P1：截止时间已过但不足 24 小时的浮动事项，候选文案与分数。
    // ------------------------------------------------------------------
    let mut cfg1 = Config::default();
    cfg1.timezone = "UTC".to_string();
    let data1 = base_data(vec![], vec![], vec![task_at("t1", "2025-01-15T10:00:00Z")]);
    let r1 = compute_candidates(&data1, "2025-01-15T11:30:00Z", &cfg1).unwrap();
    let t1c = r1
        .secondary
        .iter()
        .chain(r1.main.iter())
        .find(|c| c.source_id == "t1");
    println!(
        "P1 overdue-90min task: reason={:?} timeLabel={:?} score={:?} layer={:?}",
        t1c.map(|c| c.reason.clone()),
        t1c.and_then(|c| c.time_label.clone()),
        t1c.map(|c| c.score),
        t1c.map(|c| c.layer)
    );

    // ------------------------------------------------------------------
    // P2：逾期 25 小时（跨天）的浮动事项文案。
    // ------------------------------------------------------------------
    let data2 = base_data(vec![], vec![], vec![task_at("t1", "2025-01-14T09:00:00Z")]);
    let r2 = compute_candidates(&data2, "2025-01-15T11:30:00Z", &cfg1).unwrap();
    let t2c = r2
        .secondary
        .iter()
        .chain(r2.main.iter())
        .find(|c| c.source_id == "t1");
    println!(
        "P2 overdue-26h task: reason={:?} timeLabel={:?} score={:?}",
        t2c.map(|c| c.reason.clone()),
        t2c.and_then(|c| c.time_label.clone()),
        t2c.map(|c| c.score)
    );

    // ------------------------------------------------------------------
    // P3：NLP 超大「X天后」是否崩溃/溢出。
    // ------------------------------------------------------------------
    let now3 = Utc.with_ymd_and_hms(2025, 1, 15, 4, 0, 0).single().unwrap();
    for text in [
        "999999天后开会",
        "9999999999天后开会",
        "999999999999999天后开会",
    ] {
        let out = std::panic::catch_unwind(AssertUnwindSafe(|| {
            parse_natural_language(text, "Asia/Shanghai", &now3)
        }));
        match out {
            Ok(r) => println!(
                "P3 nlp '{text}': ok matched={} date={:?}",
                r.matched, r.date
            ),
            Err(_) => println!("P3 nlp '{text}': PANIC"),
        }
    }

    // ------------------------------------------------------------------
    // P4：NLP 非法日期「2月30日」「31号」的静默钳制。
    // ------------------------------------------------------------------
    let now4 = Utc.with_ymd_and_hms(2025, 1, 15, 4, 0, 0).single().unwrap();
    for text in ["2月30日交付", "31号交付"] {
        let r = parse_natural_language(text, "Asia/Shanghai", &now4);
        println!(
            "P4 nlp '{text}': matched={} date={:?} allDay={} title={:?}",
            r.matched, r.date, r.all_day, r.title
        );
    }

    // ------------------------------------------------------------------
    // P5：事件 start/end 倒置（end 早于 start）时候选表现。
    // ------------------------------------------------------------------
    let mut ev5 = event_at("e1", "2025-01-15T10:00:00Z", None);
    ev5.end = Some("2025-01-15T09:00:00Z".to_string());
    let data5 = base_data(vec![ev5.clone()], vec![], vec![]);
    let r5 = compute_candidates(&data5, "2025-01-15T09:30:00Z", &cfg1).unwrap();
    println!(
        "P5 inverted event at 09:30: main={:?} any-event-in-candidates={}",
        r5.main
            .as_ref()
            .map(|c| (c.source_id.clone(), c.layer, c.reason.clone())),
        r5.main
            .iter()
            .chain(r5.secondary.iter())
            .any(|c| c.source_id == "e1")
    );

    // ------------------------------------------------------------------
    // P6：跨午夜窗口（22:00–02:00）在核心层的时间语义。
    // ------------------------------------------------------------------
    let t_start = timeutil::parse_hhmm("23:00").unwrap();
    let t_end = timeutil::parse_hhmm("02:00").unwrap();
    println!(
        "P6 cross-midnight in-window(23:00)={} minutes_between={}",
        timeutil::time_in_window(t_start, timeutil::parse_hhmm("22:00").unwrap(), t_end),
        timeutil::minutes_between(timeutil::parse_hhmm("22:00").unwrap(), t_end)
    );

    // ------------------------------------------------------------------
    // P7：存储版本号 > u32::MAX 被 as u32 截断。
    // ------------------------------------------------------------------
    let dir7 = std::env::temp_dir().join(format!(
        "qa-probe-v7-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    std::fs::create_dir_all(&dir7).unwrap();
    std::fs::write(
        dir7.join("config.json"),
        r#"{"version":4294967297,"timezone":"UTC"}"#,
    )
    .unwrap();
    let mut storage7 = Storage::new(dir7);
    match storage7.read_config() {
        Ok(c) => println!(
            "P7 version 2^32+1: ACCEPTED, migrated version={}",
            c.version
        ),
        Err(e) => println!("P7 version 2^32+1: REJECTED: {e}"),
    }

    // ------------------------------------------------------------------
    // P9：weekly 间隔 >1 + daysOfWeek 的展开语义。
    // ------------------------------------------------------------------
    let rep9 = Repeat {
        repeat_type: "weekly".to_string(),
        interval: 2,
        days_of_week: vec![1, 3],
        end: None,
    };
    let ev9 = event_at("e9", "2025-01-06T09:00:00Z", Some(rep9)); // 周一锚点
    let occ9 = schedule_core::expand_events(
        &[ev9],
        NaiveDate::from_ymd_opt(2025, 1, 6).unwrap(),
        NaiveDate::from_ymd_opt(2025, 1, 22).unwrap(),
        "UTC",
    );
    println!(
        "P9 weekly interval=2 days=[1,3]: {}",
        occ9.iter()
            .map(|o| o.local_date.clone())
            .collect::<Vec<_>>()
            .join(",")
    );

    // ------------------------------------------------------------------
    // P10：search 日期范围 from > to 的表现。
    // ------------------------------------------------------------------
    let data10 = base_data(
        vec![event_at("e10", "2025-01-15T09:00:00Z", None)],
        vec![],
        vec![],
    );
    let q10 = SearchQuery {
        text: String::new(),
        tags: vec![],
        date_from: Some("2025-02-01".to_string()),
        date_to: Some("2025-01-01".to_string()),
    };
    let s10 = search(&data10, &q10);
    println!(
        "P10 search from>to: events={} (silently empty?)",
        s10.events.len()
    );

    // ------------------------------------------------------------------
    // P11：everyDays 模式锚点未来日期、N 边界。
    // ------------------------------------------------------------------
    let w11 = TimeWindow {
        days_of_week: vec![],
        start: "08:00".to_string(),
        end: "09:00".to_string(),
        every_days: Some(365),
        anchor_date: Some("2025-01-01".to_string()),
    };
    let d11 = NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
    println!(
        "P11 everyDays=365 anchor 01-01 on 12-31: {}",
        time_window_matches_date(&w11, d11)
    );
    let d11b = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
    println!(
        "P11 everyDays=365 anchor 01-01 on 2026-12-31: {}",
        time_window_matches_date(&w11, d11b)
    );

    // ------------------------------------------------------------------
    // P12：统计口径：手动归档 0 分钟是否也计入 tagDurations。
    // ------------------------------------------------------------------
    let mut days12: BTreeMap<String, schedule_core::ArchiveDay> = BTreeMap::new();
    days12.insert(
        "2025-01-15".to_string(),
        schedule_core::ArchiveDay {
            entries: vec![schedule_core::ArchiveEntry {
                id: "a1".to_string(),
                time: "09:00".to_string(),
                title: "manual".to_string(),
                source: ArchiveSource::Manual,
                source_id: None,
                note: None,
                duration_minutes: None,
                done_at: "2025-01-15T09:00:00Z".to_string(),
            }],
            summary: None,
            updated_at: String::new(),
        },
    );
    let st12 = schedule_core::compute_stats(
        &days12,
        &[],
        &[],
        &[],
        &[],
        NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
        NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
    );
    println!(
        "P12 manual archive no duration: totals={:?} tagDurations={:?}",
        st12.totals, st12.tag_durations
    );

    // ------------------------------------------------------------------
    // P13：候选排序稳定性：同层同分浮动事项。
    // ------------------------------------------------------------------
    let mut data13 = base_data(
        vec![],
        vec![],
        vec![
            task_at("tA", "2025-12-31T00:00:00Z"),
            task_at("tB", "2025-12-31T00:00:00Z"),
        ],
    );
    data13.tasks[0].id = "tA".to_string();
    data13.tasks[1].id = "tB".to_string();
    let r13 = compute_candidates(&data13, "2025-01-15T12:00:00Z", &cfg1).unwrap();
    let order: Vec<String> = r13
        .main
        .iter()
        .chain(r13.secondary.iter())
        .map(|c| c.source_id.clone())
        .collect();
    println!("P13 equal tasks order: {:?}", order);

    // ------------------------------------------------------------------
    // P14：NLP 12 点制的跨时段歧义（晚上12点/凌晨12点）。
    // ------------------------------------------------------------------
    for text in [
        "晚上12点开会",
        "凌晨12点开会",
        "下午12点半开会",
        "明天3点半开会",
        "下午3点半开会",
    ] {
        let r = parse_natural_language(text, "Asia/Shanghai", &now4);
        println!("P14 nlp '{text}': time={:?} start={}", r.time, r.start);
    }

    // ------------------------------------------------------------------
    // P15：异常提醒偏移量（i64::MAX）是否导致候选计算崩溃。
    // ------------------------------------------------------------------
    let mut ev15 = event_at("e15", "2025-01-15T09:00:00Z", None);
    ev15.reminders.push(schedule_core::Reminder {
        offset_minutes: i64::MAX,
    });
    let data15 = base_data(vec![ev15], vec![], vec![]);
    let r15 = std::panic::catch_unwind(AssertUnwindSafe(|| {
        compute_candidates(&data15, "2025-01-15T08:00:00Z", &cfg1)
    }));
    match r15 {
        Ok(r) => println!(
            "P15 huge reminder offset: ok, reminders={}",
            r.map(|x| x.due_reminders.len()).unwrap_or(0)
        ),
        Err(_) => println!("P15 huge reminder offset: PANIC"),
    }

    let _ = Duration::days(1);
    println!("QA_PROBE_DONE");

    // ------------------------------------------------------------------
    // P8：load_archive_range 非法起始月份是否会死循环（放在最后执行）。
    // ------------------------------------------------------------------
    let dir8 = std::env::temp_dir().join(format!(
        "qa-probe-v8-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    std::fs::create_dir_all(dir8.join("archive")).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let dir8c = dir8.clone();
    std::thread::spawn(move || {
        let mut storage = Storage::new(dir8c);
        let r = storage.load_archive_range("2025-13", "2026-01");
        let _ = tx.send(r.map(|m| m.len()));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(r) => println!("P8 malformed archive range: returned {:?}", r),
        Err(_) => {
            println!("P8 malformed archive range: STILL RUNNING after 5s (possible hang)");
            std::process::exit(7); // 主动结束探针进程，避免挂死
        }
    }
}
