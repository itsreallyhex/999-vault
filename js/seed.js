/* ============================================================
   Offline fallback catalogue.

   Only used when the live archive fetch in api.js fails. Metadata
   sampled from the public juicevault catalogue: titles, alternate
   names, durations, category, file size, archive date. No audio.
   ============================================================ */
export const SEED = [
  {"t": "Moncler Year (v3)", "a": ["Moncler Year (v1.2)"], "len": "2:47", "c": "main", "sz": "7.1 MB", "p": 14063, "d": "2026-02-12", "se": false},
  {"t": "Your Mom (v2)", "a": ["Your Mom (v1.1)", "Baked Up", "Ur Mom"], "len": "2:24", "c": "main", "sz": "5.9 MB", "p": 12145, "d": "2026-02-12", "se": false},
  {"t": "Talk Too Much", "a": ["Cash Out"], "len": "4:04", "c": "main", "sz": "9.5 MB", "p": 9552, "d": "2026-02-12", "se": false},
  {"t": "TURKEY BURGERS", "a": [], "len": "1:06", "c": "main", "sz": "2.9 MB", "p": 8713, "d": "2026-02-12", "se": false},
  {"t": "Tick-Tock (v3)", "a": ["Tick-Tock (v1.2)", "In The Air"], "len": "4:07", "c": "main", "sz": "12.4 MB", "p": 6821, "d": "2026-02-12", "se": false},
  {"t": "Blade (v3)", "a": ["Blade (v1.2)", "Bloody Blade", "Hell's Fire"], "len": "2:43", "c": "main", "sz": "6.4 MB", "p": 2286, "d": "2026-02-12", "se": false},
  {"t": "Party In My Mind (v2)", "a": ["Party In My Mind (v1.3)", "Until I Die"], "len": "2:36", "c": "main", "sz": "9.5 MB", "p": 2206, "d": "2026-02-12", "se": false},
  {"t": "999", "a": ["Alkaline"], "len": "3:12", "c": "main", "sz": "8.0 MB", "p": 2111, "d": "2026-02-12", "se": false},
  {"t": "1772 Moon (Friends)", "a": ["Mula", "Friends", "1772 Moon"], "len": "5:02", "c": "main", "sz": "11.8 MB", "p": 1964, "d": "2026-02-15", "se": false},
  {"t": "Hourglass", "a": ["Lost My Mind"], "len": "3:24", "c": "main", "sz": "8.2 MB", "p": 1894, "d": "2026-02-12", "se": false},
  {"t": "Macaroni Sound (v1)", "a": ["Extra"], "len": "3:01", "c": "main", "sz": "7.9 MB", "p": 1831, "d": "2026-02-12", "se": false},
  {"t": "24 Hours (v6)", "a": ["24 Hours (v1.5)", "Secure The Bag"], "len": "4:30", "c": "main", "sz": "14.2 MB", "p": 1791, "d": "2026-02-12", "se": false},
  {"t": "AP TikTok", "a": ["2019 My Year", "AP Tick-Tock"], "len": "2:49", "c": "main", "sz": "15.6 MB", "p": 1757, "d": "2026-02-12", "se": false},
  {"t": "Underworld", "a": ["Demon Girl"], "len": "3:00", "c": "main", "sz": "8.7 MB", "p": 1744, "d": "2026-02-12", "se": false},
  {"t": "Stick Talk (v2)", "a": ["Stick Talk (v1.1)", "Lava Girl"], "len": "3:48", "c": "main", "sz": "9.0 MB", "p": 1735, "d": "2026-02-12", "se": false},
  {"t": "Glo Limit (feat. Chief Keef) [Remaster]", "a": [], "len": "2:49", "c": "remaster", "sz": "7.1 MB", "p": 512, "d": "2026-06-03", "se": false},
  {"t": "!DT x NM - Travel 140BPM - Fm - 140", "a": [], "len": "5:02", "c": "instrumental", "sz": "77.0 MB", "p": 496, "d": "2026-06-01", "se": false},
  {"t": "Let's Ride (Remaster)", "a": [], "len": "3:37", "c": "remaster", "sz": "11.6 MB", "p": 475, "d": "2026-06-03", "se": false},
  {"t": "(people talk) Purple Love (1Mind)", "a": [], "len": "3:32", "c": "instrumental", "sz": "5.3 MB", "p": 275, "d": "2026-06-01", "se": false},
  {"t": "Californication", "a": [], "len": "2:08", "c": "stem", "sz": "5.0 MB", "p": 266, "d": "2026-07-13", "se": false},
  {"t": "Cupid's Carcass", "a": [], "len": "3:35", "c": "stem", "sz": "8.4 MB", "p": 212, "d": "2026-07-13", "se": false},
  {"t": "100 Band Jugg (feat. ILOVEMAKONNEN) [Cut]", "a": [], "len": "1:52", "c": "cut", "sz": "7.4 MB", "p": 159, "d": "2026-07-15", "se": false},
  {"t": "Empty Out Your Pockets (v2) [Cut]", "a": [], "len": "2:16", "c": "cut", "sz": "7.8 MB", "p": 130, "d": "2026-07-15", "se": false},
  {"t": "Burberry Timbs (v3) [feat. Vince Staples]", "a": ["Burberry Timbs (v1)", "Stomp"], "len": "3:08", "c": "remaster", "sz": "5.5 MB", "p": 117, "d": "2026-06-03", "se": false},
  {"t": "1400 / 999 Freestyle", "a": [], "len": "2:56", "c": "released", "sz": "7.5 MB", "p": 115, "d": "2026-07-13", "se": false},
  {"t": "KTM Drip (NM Fadeaway)", "a": ["KTM Drip (v1.1)", "Don't Fall Off", "Yee-Haw"], "len": "4:12", "c": "stem", "sz": "9.8 MB", "p": 109, "d": "2026-07-13", "se": false},
  {"t": "DYBH21BOB", "a": ["Never Alone* (with G Herbo)"], "len": "3:00", "c": "instrumental", "sz": "7.3 MB", "p": 108, "d": "2026-06-01", "se": false},
  {"t": "Abyss", "a": ["Abyss (v1.3)", "The Party Never Ends"], "len": "3:16", "c": "stem", "sz": "7.6 MB", "p": 104, "d": "2026-07-13", "se": false},
  {"t": "Man Of The Year (999)", "a": ["Man Of The Year (v1)", "M.O.T.Y.", "Breakthrough"], "len": "2:19", "c": "released", "sz": "5.5 MB", "p": 104, "d": "2026-07-13", "se": false, "art": "https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/39/b1/1e/39b11eef-4709-bf53-2b5b-7954d2782496/20UMGIM58296.rgb.jpg/600x600bb.jpg"},
  {"t": "10 Feet", "a": ["10 Feet (v3)", "Ten Feet"], "len": "3:32", "c": "released", "sz": "9.7 MB", "p": 92, "d": "2026-07-13", "se": false, "art": "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/62/10/cf/6210cf4a-be77-3d97-218d-834f68bb33b3/19UMGIM16006.rgb.jpg/600x600bb.jpg"},
  {"t": "We Don't Get Along", "a": ["We Don't Get Along (v1.1)", "Random Own Guitar Beat"], "len": "2:29", "c": "released", "sz": "6.3 MB", "p": 90, "d": "2026-07-13", "se": false, "art": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/1d/e8/b1/1de8b1dd-6de5-3e1a-38aa-59108ac55aff/198704875731_Cover.jpg/600x600bb.jpg"},
  {"t": "27 Club", "a": ["Help Me (v1)"], "len": "2:02", "c": "stem", "sz": "4.0 MB", "p": 85, "d": "2026-07-13", "se": false},
  {"t": "Wishing Well", "a": ["Wishing Well (v2)", "I Can't Breathe", "Lauryn Hill"], "len": "3:15", "c": "released", "sz": "9.0 MB", "p": 80, "d": "2026-07-13", "se": false, "art": "https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/39/b1/1e/39b11eef-4709-bf53-2b5b-7954d2782496/20UMGIM58296.rgb.jpg/600x600bb.jpg"},
  {"t": "Cross The Globe (feat. Juice WRLD)", "a": ["Cross The Globe"], "len": "2:05", "c": "released", "sz": "5.4 MB", "p": 77, "d": "2026-07-13", "se": false},
  {"t": "Codeine Cowboys (NM Forgiato)", "a": ["Personality Disorder", "Codeine Cowboys"], "len": "4:00", "c": "stem", "sz": "9.3 MB", "p": 76, "d": "2026-07-13", "se": false},
  {"t": "On The Pills (Cut)", "a": ["On The Pills", "Façade"], "len": "2:19", "c": "cut", "sz": "5.6 MB", "p": 59, "d": "2026-07-15", "se": false},
  {"t": "Party In My Mind (v3) [Cut]", "a": ["Party In My Mind (v1.3)", "Until I Die"], "len": "2:26", "c": "cut", "sz": "8.7 MB", "p": 46, "d": "2026-07-15", "se": false},
  {"t": "170 LRa2", "a": ["Bussin'", "170 LRA2"], "len": "2:12", "c": "instrumental", "sz": "3.3 MB", "p": 42, "d": "2026-07-23", "se": false},
  {"t": "Off The Rip (v1) [Cut]", "a": ["Off The Rip (v2)", "Gamble"], "len": "1:57", "c": "cut", "sz": "12.6 MB", "p": 41, "d": "2026-07-15", "se": false}
];
