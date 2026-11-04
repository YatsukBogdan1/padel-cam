// STL export wrapper: one part per run, already in print orientation.
//   openscad -o body.stl -D 'export="body"' export.scad
// Parts: body, lid, cradle, tray, cover, bezel   (mount is exported on request)
include <enclosure_v1.scad>
part = "none";          // silence the main file's own output
export = "body";

if (export == "body")   translate([0, 0, floor_t]) body();                 // floor down
if (export == "lid")    translate([0, od, inner_h + lid_t]) rotate([180, 0, 0]) lid();   // top face down (as print_plate)
if (export == "cradle") translate([0, -55, plate_y + plate_t]) rotate([-90, 0, 0]) cradle(); // plate back face down
if (export == "tray")   translate([0, -75, wall + inner_d]) rotate([-90, 0, 0]) tray();      // back face down
if (export == "cover")  rotate([0, -90, 0]) translate([ow/2 + cover_t, -37, 0]) cover();     // outer face down
if (export == "bezel")  translate([0, 0, bezel_t]) rotate([90, 0, 0]) bezel();               // outer face down
if (export == "mount")  rotate([180, 0, 0]) beam_mount();
