// Slot grid, shared by everyone. Courses, classes and the academic
// calendar come from each person's own import.
const CONFIG = {
  minPercent: 75,

  slots: {
    theoryTimes: ["08:00", "08:55", "09:50", "10:45", "11:40", "12:35", "14:00", "14:55", "15:50", "16:45", "17:40", "18:35"],
    labTimes: ["08:00", "08:50", "09:50", "10:40", "11:40", "12:30", "14:00", "14:50", "15:50", "16:40", "17:40", "18:30"],
    theory: {
      Mon: "A1 F1 D1 TB1 TG1 S11 A2 F2 D2 TB2 TG2 S3",
      Tue: "B1 G1 E1 TC1 TAA1 - B2 G2 E2 TC2 TAA2 S1",
      Wed: "C1 A1 F1 TD1 TBB1 - C2 A2 F2 TD2 TBB2 S4",
      Thu: "D1 B1 G1 TE1 TCC1 - D2 B2 G2 TE2 TCC2 S2",
      Fri: "E1 C1 TA1 TF1 TDD1 S15 E2 C2 TA2 TF2 TDD2 -",
    },
    // First morning and first afternoon lab slot of each day (six in a row each).
    lab: { Mon: [1, 31], Tue: [7, 37], Wed: [13, 43], Thu: [19, 49], Fri: [25, 55] },
  },
};
