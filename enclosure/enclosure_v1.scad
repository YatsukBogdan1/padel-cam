// =====================================================================
//  padel-cam-enclosure.scad   (v6 - all-bolted, zero plastic threads)
//  Enclosure for Raspberry Pi 4 / Pi 5 + Arducam IMX477 HQ camera
//  (C/CS-mount lens), with manually adjustable camera tilt.
//
//  EVERY fastener is a machine bolt + hex nut captured in a printed
//  pocket - no self-tapping into plastic, so parts survive unlimited
//  assemble/disassemble cycles. Only the saddle->beam screws are
//  wood screws (they thread into wood, not plastic).
//
//  Nut locations (insert once; most become captive):
//    lid bosses   - side-load slots near the boss tops, openings
//                   face the box interior (drop nuts in from above)
//    tray rail    - slots open at the rail's FRONT face; insert the
//                   2 nuts BEFORE mounting the Pi - the Pi board
//                   then traps them permanently
//    Pi standoffs - hex pockets in the tray's back face; the rear
//                   wall traps them once the tray is in
//    camera       - hex pockets in the cradle plate's back face
//    pivot + lock - hex pockets on the cheeks' inner faces
//    window cover - 2 permanent M3 studs through the wall (heads
//                   inside, hex-recessed against rotation); the
//                   cover goes on/off with external nuts only
//    lens bezel   - 4 permanent M3 studs through the FRONT wall, same
//                   pattern as the cover. The front wall carries a
//                   large service window; the bezel bolted over it
//                   holds the lens opening. Take the bezel off to
//                   reach the focus ring / lock screw, or swap in a
//                   bezel with a different hole for a different lens.
//    ears->saddle - M4 hex pockets under the saddle plate
//
//  BOM (bolts + nuts):
//    8x M2.5x12 + nuts  (camera, Pi)
//    2x M3x12   + nuts  (pivot)          2x M3x14 + washers + nuts (lock)
//    6x M3x12   + nuts  (lid: 4 bosses + 2 tray rail)
//    2x M3x10   + nuts  (cover studs; nuts are the service fastener)
//    4x M3x10   + nuts  (bezel studs; nuts are the service fastener)
//    4x M4x12   + nuts  (ears -> saddle)
//    6x 4x30 + 2x 4x40 wood screws (saddle -> beam)
//
//  v7 changes (after the first printed v6):
//    - USB-C opening moved toward the lens (away from the back wall)
//      and deepened so the plug overmold is not pinched: usbc_shift,
//      port_d
//    - front lens slot replaced by a service window + bolt-on bezel:
//      front_bezel, bwin_*, bezel_*
//    - cleanup of features that cut into each other: lid lip now wraps
//      around the bosses (lip2d) instead of being notched by them; tray
//      rail bolts moved to x = +/-10 so their lid counterbores stay out
//      of the USB-C opening; lid vents shortened to stay clear of the
//      USB-C collar; service window narrowed to 40 so it never touches
//      the front lid bosses
// =====================================================================

/* [Part selection] */
part = "assembly"; // [assembly, body, lid, cradle, tray, cover, bezel, mount, print_plate]
show_tilt  = 0;
explode    = 0;
show_pi    = true;
show_mount = true;
show_cover = true;

/* [Shell] */
wall    = 3;
floor_t = 3;
lid_t   = 3;
inner_w = 94;
inner_d = 68;
inner_h = 62;
lip_h   = 3;
lip_w   = 2.4;
boss_clear = 0.75;   // radial gap between the lid lip and each boss
lip_cut_y  = 52;     // no lip behind this y (tray rail + Pi live there)

/* [Fits, bolts & nuts] */
slide_clear = 0.30;
m25_thru = 2.8;   nut25_af = 5.3;  nut25_t = 2.3;   // M2.5 (AF 5.0, t 2.0)
m3_thru  = 3.4;   nut3_af  = 5.8;  nut3_t  = 2.8;   // M3   (AF 5.5, t 2.4)
m4_thru  = 4.5;   nut4_af  = 7.4;  nut4_t  = 3.5;   // M4   (AF 7.0, t 3.2)
cbore_d = 6.5;
cbore_h = 1.8;

/* [Camera & tilt] */
pivot_y     = 22;
pivot_z     = 30;
tilt_range  = 12;
lock_r      = 18;
lens_hole_d = 40;   // only used when front_bezel = false (plain slot in the wall)
cam_pitch   = 30;
plate_w = 44;  plate_h = 44;  plate_t = 4;  plate_y = 30;
cam_standoff_h = 5;  cam_standoff_d = 6;
cheek_t = 6;  cheek_d = 14;

/* [Front service window + lens bezel] */
front_bezel  = true;   // false = old behaviour: a plain lens slot in the wall
bwin_w  = 40;          // service window in the front wall (x). Keep <= 40:
                       // the front lid bosses start at |x| = 21.5
bwin_z0 = 4;  bwin_z1 = 56;                 // ... and its z extent (must exceed
                       // bezel_hole_d + 2*bezel_swing so the wall never shows)
bezel_w = 84;          // bezel plate outline (x)
bezel_z0 = 1; bezel_z1 = 59;                // ... and its z extent
bezel_t   = 2.5;       // plate thickness outside the wall
bezel_lip = 0;         // optional locating lip into the window; 0 = none
                       // (the four studs locate the plate; a lip beside a
                       // 38 mm opening in a 40 mm window would be a sliver)
bezel_hole_d = 38;     // lens opening: barrel OD + room for the focus
                       // ring / lock screw. CS lens ~28-30 mm -> 38;
                       // M12 lens + adapter is narrower, ~30 is enough
// [x, z] of the M3 studs. Keep |x| >= 36: the inner hex recesses must
// clear the front lid bosses (x = +/-26, d 9).
bezel_stud_pts = [[-36, 12], [36, 12], [-36, 48], [36, 48]];

/* [Raspberry Pi 4 / 5 - vertical, connectors UP] */
pi_l = 85;  pi_w = 56;
pi_hole_dx = 58;  pi_hole_dy = 49;
pi_standoff_h = 5;  pi_standoff_d = 6;
pi_sd_gap = 4;
pi_z0 = 5;
usbc_offset = 11.2;
port_w = 14;
port_d = 11;           // opening depth (y). USB-C plug overmolds run 6-8 mm; was 8
usbc_shift = 3.5;      // move the opening this far toward the lens, i.e. AWAY from
                       // the back wall / Pi tray (negative = toward it); was 0.
                       // The receptacle axis sits ~1.6 mm in front of the board face.
port_collar = true;
hdmi_cutout = false;

/* [USB / Ethernet service window (left wall)] */
side_window = true;
win_y0 = 44;  win_y1 = 63;
win_z0 = 6.5; win_z1 = 58;
cover_t = 2.5;
cover_lip = 2.3;
cover_stud_pts = [[65, 32], [48, 3.2]];    // [y, z] of the M3 studs

/* [Tray] */
tray_t = 4;          // thick enough for the Pi nut pockets
rail_t = 8;          // thick enough for the rail nut slots
rail_h = 8;
trib_w = 6;
rail_screw_x = 10;   // was 28: the +x counterbore broke into the USB-C
                     // opening. Must stay clear of the upper-left Pi
                     // standoff (x -21.5..-15.5) and the rib slot (|x|<3.2)

/* [Ventilation] */
vent_w = 2.5;  vent_h = 26;  vent_z0 = 16;
vent_n = 3;    vent_pitch = 6;  vent_y0 = 44;
rear_vent_xs = [-19.5,-13.5,-7.5,7.5,13.5,19.5];
rear_vent_z0 = 20;  rear_vent_h = 24;
lid_vents = true;  lid_vent_n = 9;  lid_vent_pitch = 7.5;
lid_vent_l = 8;    lid_vent_y0 = 40;   // must end >= 2 mm before the
                                       // USB-C collar (port_y0 - 2)

/* [Wall-mount ears] */
mount_ears = true;
ear_w = 12;  ear_t = 3;  ear_hole = 4.5;

/* [Beam-mount saddle - beam runs along the camera axis] */
beam_w     = 70;
beam_clear = 0.5;
mplate_t   = 6;
flange_t   = 5;
flange_h   = 28;
wood_screw = 4.5;

/* [Hidden] */
$fn = 64;
eps = 0.01;
ow  = inner_w + 2*wall;
od  = inner_d + 2*wall;
tray_front = wall + inner_d - tray_t;
rail_y0 = wall + inner_d - rail_t;         // rail front face
rail_ny = rail_y0 + 3;                     // rail bolt axis (y)
pi_sd_x = inner_w/2 - pi_sd_gap;
usbc_x  = pi_sd_x - usbc_offset;
boss_d = 9;
nut_slot_z = inner_h - 6;                  // lid-nut centre height
// lid bosses: [x, y, slot direction angle (opening faces interior)]
boss_pts = [ [ 26,              wall + 2,  0   ],
             [-26,              wall + 2,  0   ],
             [ inner_w/2 - 2,   38.5,      90  ],
             [-(inner_w/2-2),   38.5,     -90  ] ];
stop_xs = [8.5, 34];
ear_hx  = ow/2 + ear_w - 6;
ear_ys  = [10, od - 10];
msaddle_top = -floor_t;
port_y0 = 56 - usbc_shift;                 // front edge of the USB-C opening (v6: 56, 8 deep)
bezel_swing = (pivot_y + bezel_t) * tan(tilt_range);   // lens travel at the bezel's outer face

echo(str("Lens slot vertical travel: +/- ",
         (pivot_y - wall/2) * tan(tilt_range), " mm"));
echo(str("Outer size: ", ow, " x ", od, " x ",
         inner_h + lid_t + floor_t, " mm"));
echo(str("USB-C opening y = ", port_y0, " .. ", port_y0 + port_d,
         " (receptacle axis ~", tray_front - pi_standoff_h - 1.4 - 1.6,
         ", back wall inner face ", wall + inner_d, ")"));

function pi_holes_v() =
    [ for (hx = [3.5, 3.5 + pi_hole_dx],
           hz = [3.5, 3.5 + pi_hole_dy])
        [pi_sd_x - hx, pi_z0 + hz] ];

// ------------------------------------------------------------ helpers
module stadium2d(d, l) {
    hull() {
        translate([0,  l/2]) circle(d = d);
        translate([0, -l/2]) circle(d = d);
    }
}

module xcyl(y, z, d) {
    translate([-ow/2 - 1, y, z])
        rotate([0, 90, 0])
            cylinder(d = d, h = ow + 2);
}

// hex prism for a nut, vertical axis, across-flats af, height t
module hex_v(af, t) {
    rotate([0, 0, 30])
        cylinder(d = af*2/sqrt(3), h = t, $fn = 6);
}

// vertical-axis nut + side insertion channel along +Y (rotate to aim)
module nut_slot_v(af, t) {
    hex_v(af, t);
    translate([-af/2, 0, 0]) cube([af, af + 4, t]);
}

// horizontal-axis (X) hex pocket, depth t along +X
module hex_x(af, t) {
    rotate([0, 90, 0]) rotate([0, 0, 30])
        cylinder(d = af*2/sqrt(3), h = t, $fn = 6);
}

// horizontal-axis (Y) hex pocket, depth t along +Y
module hex_y(af, t) {
    rotate([-90, 0, 0]) rotate([0, 0, 30])
        cylinder(d = af*2/sqrt(3), h = t, $fn = 6);
}

// ------------------------------------------------------------ body
module lens_slot() {
    swing = (pivot_y - wall/2) * tan(tilt_range);
    translate([0, -eps, pivot_z])
        rotate([-90, 0, 0])
            linear_extrude(wall + 2*eps)
                stadium2d(lens_hole_d, 2*swing);
}

// Large opening in the front wall; the bezel bolts over it.
module front_window() {
    translate([-bwin_w/2, -1, bwin_z0])
        cube([bwin_w, wall + 2, bwin_z1 - bwin_z0]);
}

module arc_slot() {
    step = 2;
    for (a = [-tilt_range : step : tilt_range - step])
        hull() {
            xcyl(pivot_y + lock_r*sin(a),
                 pivot_z - lock_r*cos(a),      m3_thru);
            xcyl(pivot_y + lock_r*sin(a+step),
                 pivot_z - lock_r*cos(a+step), m3_thru);
        }
}

module side_vents() {
    for (i = [0 : vent_n - 1])
        translate([-ow/2 - 1, vent_y0 + i*vent_pitch, vent_z0])
            cube([ow + 2, vent_w, vent_h]);
}

module rear_vents() {
    for (x = rear_vent_xs)
        translate([x - vent_w/2, wall + inner_d - eps, rear_vent_z0])
            cube([vent_w, wall + 2*eps, rear_vent_h]);
}

module ear(sx, y) {
    hull() {
        translate([sx*ear_hx, y, -floor_t])       cylinder(d = 12, h = ear_t);
        translate([sx*(ow/2 - 6), y, -floor_t])   cylinder(d = 12, h = ear_t);
    }
}

module body() {
    difference() {
        union() {
            difference() {
                translate([-ow/2, 0, -floor_t])
                    cube([ow, od, inner_h + floor_t]);
                translate([-inner_w/2, wall, 0])
                    cube([inner_w, inner_d, inner_h + eps]);
            }
            for (p = boss_pts)
                translate([p[0], p[1], 0])
                    cylinder(d = boss_d, h = inner_h);
            translate([-trib_w/2, tray_front, 0])
                cube([trib_w, tray_t, inner_h]);
            for (x = stop_xs)
                translate([x - 4, tray_front - 4.2, 0])
                    cube([8, 4, 4]);
            if (mount_ears)
                for (sx = [-1, 1], y = ear_ys) ear(sx, y);
        }
        if (front_bezel) {
            front_window();
            // bezel studs: through holes + inner hex recess, same idea
            // as the side-window cover studs
            for (p = bezel_stud_pts) {
                translate([p[0], -1, p[1]])
                    rotate([-90, 0, 0])
                        cylinder(d = 3.2, h = wall + 2);
                translate([p[0], wall - 1.0, p[1]])
                    hex_y(nut3_af, 1.0 + eps);
            }
        } else {
            lens_slot();
        }
        xcyl(pivot_y, pivot_z, m3_thru);
        arc_slot();
        side_vents();
        rear_vents();
        if (side_window) {
            translate([-ow/2 - 1, win_y0, win_z0])
                cube([wall + 2, win_y1 - win_y0, win_z1 - win_z0]);
            // cover studs: through holes + inner hex recess so the
            // permanently-installed M3 bolt heads cannot rotate
            for (p = cover_stud_pts) {
                translate([-ow/2 - 1, p[0], p[1]])
                    rotate([0, 90, 0])
                        cylinder(d = 3.2, h = wall + 2);
                translate([-inner_w/2 - 1.0, p[0], p[1]])
                    rotate([0, 0, 0])
                        hex_x(nut3_af, 1.0 + eps);
            }
        }
        // lid bolts: bore + side-load nut slot near each boss top
        for (p = boss_pts) {
            translate([p[0], p[1], nut_slot_z - 10])
                cylinder(d = m3_thru, h = inner_h);
            translate([p[0], p[1], nut_slot_z - nut3_t/2])
                rotate([0, 0, p[2]])
                    nut_slot_v(nut3_af, nut3_t);
        }
        if (mount_ears)
            for (sx = [-1, 1], y = ear_ys)
                translate([sx*ear_hx, y, -floor_t - eps])
                    cylinder(d = ear_hole, h = ear_t + 2*eps);
    }
}

// ------------------------------------------------------------ cover
// Slips over the two wall studs; external M3 nuts hold it.
module cover() {
    difference() {
        union() {
            translate([-ow/2 - cover_t, 37, 0.8])
                cube([cover_t, 32, 61.2]);
            translate([-ow/2 - eps, win_y0 + 0.3, win_z0 + 0.3])
                cube([cover_lip + eps,
                      win_y1 - win_y0 - 0.6,
                      win_z1 - win_z0 - 0.6]);
        }
        for (p = cover_stud_pts)
            translate([-ow/2 - cover_t - eps, p[0], p[1]])
                rotate([0, 90, 0])
                    cylinder(d = m3_thru, h = cover_t + cover_lip + 2*eps);
    }
}

// ------------------------------------------------------------ bezel
// Bolts over the front service window on four wall studs; carries the
// lens opening (a stadium so the lens can still swing through the
// tilt range). Take it off to reach the focus ring / lock screw.
module bezel() {
    difference() {
        union() {
            translate([-bezel_w/2, -bezel_t, bezel_z0])
                cube([bezel_w, bezel_t, bezel_z1 - bezel_z0]);
            if (bezel_lip > 0)
                translate([-bwin_w/2 + 0.3, -eps, bwin_z0 + 0.3])
                    cube([bwin_w - 0.6,
                          bezel_lip + eps,
                          bwin_z1 - bwin_z0 - 0.6]);
        }
        translate([0, -bezel_t - eps, pivot_z])
            rotate([-90, 0, 0])
                linear_extrude(bezel_t + bezel_lip + 2*eps)
                    stadium2d(bezel_hole_d, 2*bezel_swing);
        for (p = bezel_stud_pts)
            translate([p[0], -bezel_t - eps, p[1]])
                rotate([-90, 0, 0])
                    cylinder(d = m3_thru, h = bezel_t + 2*eps);
    }
}

// ------------------------------------------------------------ tray
module tray() {
    tw = inner_w - 2*slide_clear;
    difference() {
        union() {
            translate([-tw/2, tray_front, 0])
                cube([tw, tray_t, inner_h]);
            translate([-tw/2, rail_y0, inner_h - rail_h])
                cube([tw, rail_t, rail_h]);
            for (p = pi_holes_v())
                translate([p[0], tray_front, p[1]])
                    rotate([90, 0, 0])
                        cylinder(d = pi_standoff_d, h = pi_standoff_h);
        }
        translate([-(trib_w/2 + 0.2), rail_y0 - 1, -1])
            cube([trib_w + 0.4, rail_t + 2, inner_h + 2]);
        for (x = rear_vent_xs)
            translate([x - vent_w/2, tray_front - 1, rear_vent_z0])
                cube([vent_w, tray_t + rail_t + 2, rear_vent_h]);
        // Pi bolts: bore through standoff+plate, hex pocket at the
        // back face (rear wall traps the nuts once the tray is in)
        for (p = pi_holes_v()) {
            translate([p[0], tray_front - pi_standoff_h - eps, p[1]])
                rotate([-90, 0, 0])
                    cylinder(d = m25_thru,
                             h = pi_standoff_h + tray_t + 2*eps);
            translate([p[0], wall + inner_d - nut25_t, p[1]])
                hex_y(nut25_af, nut25_t + 1);
        }
        // rail nuts: slots open at the rail FRONT face; insert the
        // nuts BEFORE mounting the Pi - the board then traps them
        for (s = [-1, 1]) {
            translate([s*rail_screw_x, rail_ny, inner_h - rail_h - eps])
                cylinder(d = m3_thru, h = rail_h + 2*eps);
            translate([s*rail_screw_x, rail_ny, nut_slot_z - nut3_t/2])
                rotate([0, 0, 180])
                    nut_slot_v(nut3_af, nut3_t);
        }
    }
}

// ------------------------------------------------------------ cradle
module cheek_profile() {
    hull() {
        translate([pivot_y, pivot_z])          circle(d = cheek_d);
        translate([pivot_y, pivot_z - lock_r]) circle(d = cheek_d);
    }
}

module half_cradle() {
    translate([inner_w/2 - slide_clear - cheek_t, 0, 0])
        rotate([90, 0, 90])
            linear_extrude(cheek_t)
                cheek_profile();
    hull() {
        translate([plate_w/2 - 4, plate_y, pivot_z - 10])
            cube([4, plate_t, 20]);
        translate([inner_w/2 - slide_clear - cheek_t - 2, 26, 20])
            cube([4, 4, 17]);
    }
}

module cradle() {
    cheek_in = inner_w/2 - slide_clear - cheek_t;   // cheek inner face
    difference() {
        union() {
            translate([-plate_w/2, plate_y, pivot_z - plate_h/2])
                cube([plate_w, plate_t, plate_h]);
            for (sx = [-1, 1], sz = [-1, 1])
                translate([sx*cam_pitch/2, plate_y,
                           pivot_z + sz*cam_pitch/2])
                    rotate([90, 0, 0])
                        cylinder(d = cam_standoff_d, h = cam_standoff_h);
            half_cradle();
            mirror([1, 0, 0]) half_cradle();
        }
        // pivot + lock: through bores, nuts in pockets on the
        // cheeks' inner faces
        xcyl(pivot_y, pivot_z,          m3_thru);
        xcyl(pivot_y, pivot_z - lock_r, m3_thru);
        for (s = [-1, 1], zz = [pivot_z, pivot_z - lock_r])
            translate([s == 1 ? cheek_in - eps : -cheek_in - nut3_t,
                       pivot_y, zz])
                hex_x(nut3_af, nut3_t + eps);
        translate([0, plate_y - eps, pivot_z])
            rotate([-90, 0, 0])
                cylinder(d = 18, h = plate_t + 2*eps);
        // camera bolts: bore + hex pocket at the plate's back face
        for (sx = [-1, 1], sz = [-1, 1]) {
            translate([sx*cam_pitch/2,
                       plate_y - cam_standoff_h - eps,
                       pivot_z + sz*cam_pitch/2])
                rotate([-90, 0, 0])
                    cylinder(d = m25_thru,
                             h = cam_standoff_h + plate_t + 2*eps);
            translate([sx*cam_pitch/2,
                       plate_y + plate_t - nut25_t,
                       pivot_z + sz*cam_pitch/2])
                hex_y(nut25_af, nut25_t + 1);
        }
    }
}

// ------------------------------------------------------------ lid
// Lip outline: a band inside the cavity that wraps AROUND each boss on
// a concentric arc instead of being notched by it, and stops at
// lip_cut_y where the tray rail / Pi need the room. One continuous,
// even-width feature - nothing tapers to a sliver.
module lip2d() {
    x0 = -inner_w/2 + slide_clear;  y0 = wall + slide_clear;
    w  = inner_w - 2*slide_clear;   d  = inner_d - 2*slide_clear;
    r_clear = boss_d/2 + boss_clear;
    intersection() {
        translate([x0, y0]) square([w, d]);
        difference() {
            union() {
                difference() {
                    translate([x0, y0]) square([w, d]);
                    translate([x0 + lip_w, y0 + lip_w])
                        square([w - 2*lip_w, d - 2*lip_w]);
                }
                for (p = boss_pts)
                    translate([p[0], p[1]]) circle(r = r_clear + lip_w);
            }
            for (p = boss_pts)
                translate([p[0], p[1]]) circle(r = r_clear);
            translate([-ow, lip_cut_y]) square([2*ow, od]);
        }
    }
}

module lid() {
    difference() {
        union() {
            translate([-ow/2, 0, inner_h])
                cube([ow, od, lid_t]);
            translate([0, 0, inner_h - lip_h])
                linear_extrude(lip_h + eps) lip2d();
            if (port_collar)
                difference() {
                    translate([usbc_x - port_w/2 - 2, port_y0 - 2, inner_h + lid_t - eps])
                        cube([port_w + 4, port_d + 4, 3]);
                    translate([usbc_x - port_w/2, port_y0, inner_h + lid_t - 1])
                        cube([port_w, port_d, 5]);
                }
        }
        translate([usbc_x - port_w/2, port_y0, inner_h - eps])
            cube([port_w, port_d, lid_t + 2*eps]);
        if (hdmi_cutout)
            translate([pi_sd_x - 46.5, port_y0, inner_h - eps])
                cube([27, port_d, lid_t + 2*eps]);
        for (p = boss_pts) {
            translate([p[0], p[1], inner_h - lip_h - eps])
                cylinder(d = m3_thru, h = lip_h + lid_t + 2*eps);
            translate([p[0], p[1], inner_h + lid_t - cbore_h])
                cylinder(d = cbore_d, h = cbore_h + eps);
        }
        for (s = [-1, 1]) {
            translate([s*rail_screw_x, rail_ny, inner_h - eps])
                cylinder(d = m3_thru, h = lid_t + 2*eps);
            translate([s*rail_screw_x, rail_ny, inner_h + lid_t - cbore_h])
                cylinder(d = cbore_d, h = cbore_h + eps);
        }
        if (lid_vents)
            for (i = [0 : lid_vent_n - 1])
                translate([-(lid_vent_n-1)/2*lid_vent_pitch
                             + i*lid_vent_pitch - vent_w/2,
                           lid_vent_y0,
                           inner_h - eps])
                    cube([vent_w, lid_vent_l, lid_t + 2*eps]);
    }
}

// ------------------------------------------------------------ mount
module beam_mount() {
    ch  = beam_w + beam_clear;
    px0 = -ch/2 - flange_t;
    pw  = ch + 2*flange_t;
    pd  = od;
    ppw = 2*(ear_hx + 6);
    difference() {
        union() {
            translate([-ppw/2, 0, msaddle_top - mplate_t])
                cube([ppw, pd, mplate_t]);
            for (x = [px0, px0 + pw - flange_t])
                translate([x, 0, msaddle_top - mplate_t - flange_h])
                    cube([flange_t, pd, flange_h]);
        }
        translate([-20, od/2 - 20, msaddle_top - mplate_t - eps])
            cube([40, 40, mplate_t + 2*eps]);
        // ear bolts: through holes + M4 hex pockets from below
        for (sx = [-1, 1], y = ear_ys) {
            translate([sx*ear_hx, y, msaddle_top - mplate_t - eps])
                cylinder(d = m4_thru, h = mplate_t + 2*eps);
            translate([sx*ear_hx, y, msaddle_top - mplate_t - eps])
                hex_v(nut4_af, nut4_t + eps);
        }
        for (sx = [-1, 1]) {
            translate([sx*28, od/2, msaddle_top - mplate_t - eps])
                cylinder(d = wood_screw, h = mplate_t + 2*eps);
            translate([sx*28, od/2, msaddle_top - 2])
                cylinder(d1 = wood_screw, d2 = 9.5, h = 2 + eps);
        }
        for (y = [12, od/2, od - 12], s = [0, 1]) {
            fx = px0 + s*(pw - flange_t);
            translate([fx - eps, y, msaddle_top - mplate_t - flange_h/2 - 4])
                rotate([0, 90, 0]) {
                    cylinder(d = wood_screw, h = flange_t + 2*eps);
                    translate([0, 0, s == 0 ? 0 : flange_t - 2])
                        cylinder(d1 = s == 0 ? 9.5 : wood_screw,
                                 d2 = s == 0 ? wood_screw : 9.5,
                                 h = 2);
                }
        }
    }
}

// ------------------------------------------------------------ pi mock
module pi_mock() {
    yb = tray_front - pi_standoff_h;
    yf = yb - 1.4;
    zt = pi_z0 + pi_w;
    translate([pi_sd_x - pi_l, yf, pi_z0]) cube([pi_l, 1.4, pi_w]);
    translate([usbc_x - 4.5, yf - 3.2, zt - 6.2])
        cube([9, 3.2, 7.5]);
    for (hx = [26, 39.5])
        translate([pi_sd_x - hx - 3.8, yf - 3.1, zt - 8])
            cube([7.6, 3.1, 9]);
    for (hz = [19, 37])
        translate([pi_sd_x - pi_l - 3, yf - 16, zt - hz])
            cube([20.3, 16, 15]);
    translate([pi_sd_x - pi_l - 3, yf - 13.5, pi_z0 + 2])
        cube([24.3, 13.5, 16]);
    translate([pi_sd_x - 63, yf - 19, pi_z0 + 7])
        cube([45, 19, 42]);
    translate([pi_sd_x - 11.5, yb, pi_z0 + 22])
        cube([14, 3, 12]);
}

// ------------------------------------------------------------ output
module assembly() {
    color("Gainsboro") body();
    color("DarkOrange")
        translate([0, pivot_y, pivot_z])
            rotate([show_tilt, 0, 0])
                translate([0, -pivot_y, -pivot_z])
                    cradle();
    color("Gold") translate([0, 0, explode]) tray();
    if (show_pi)
        color("ForestGreen", 0.55) translate([0, 0, explode]) pi_mock();
    color("SteelBlue", 0.45) translate([0, 0, explode*2]) lid();
    if (show_cover && side_window)
        color("Tomato") translate([-explode/2, 0, 0]) cover();
    if (show_cover && front_bezel)
        color("Tomato") translate([0, -explode/2, 0]) bezel();
    if (show_mount) {
        color("DimGray") beam_mount();
        color("Peru", 0.4)
            translate([-beam_w/2, -48, -floor_t - mplate_t - 60])
                cube([beam_w, 170, 60]);
    }
}

if (part == "assembly") assembly();
if (part == "body")     body();
if (part == "cradle")   cradle();
if (part == "lid")      lid();
if (part == "tray")     tray();
if (part == "cover")    rotate([0, -90, 0]) translate([ow/2 + cover_t, -37, 0]) cover();
if (part == "bezel")    translate([0, 0, bezel_t]) rotate([90, 0, 0]) bezel();   // outer face down
if (part == "mount")    rotate([180, 0, 0]) beam_mount();
if (part == "print_plate") {
    body();
    translate([ow + 14, od, inner_h + lid_t])
        rotate([180, 0, 0]) lid();
    translate([ow + 14, -55, plate_y + plate_t])
        rotate([-90, 0, 0]) cradle();
    translate([0, -75, wall + inner_d])
        rotate([-90, 0, 0]) tray();
    if (front_bezel)
        translate([ow + 14, -75 - 14, bezel_t])
            rotate([90, 0, 0]) bezel();
}
