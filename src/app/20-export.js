/* ============================================================
 * 20-export.js — STL / 3MF / 参数导出（无 DOM 依赖，可在 Node 中测试）
 * ============================================================ */
'use strict';

FSG.Export = (function () {
  'use strict';

  /* ---------- 二进制 STL ---------- */
  function writeSTL(mesh, opts) {
    opts = opts || {};
    var idx = mesh.idx || mesh.indices;
    var pos = mesh.pos || mesh.positions;
    var nt = idx.length / 3;
    var buf = new ArrayBuffer(84 + nt * 50);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var header = 'FSG five-stage stage / 五级台';
    for (var i = 0; i < 80; i++) {
      u8[i] = i < header.length ? header.charCodeAt(i) & 0xff : 0x20;
    }
    dv.setUint32(80, nt, true);
    var o = 84;
    function f32(v) { dv.setFloat32(o, v, true); o += 4; }
    for (var t = 0; t < nt; t++) {
      var a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      var ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      var bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      var cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      f32(nx / l); f32(ny / l); f32(nz / l);
      f32(ax); f32(ay); f32(az);
      f32(bx); f32(by); f32(bz);
      f32(cx); f32(cy); f32(cz);
      dv.setUint16(o, 0, true); o += 2;
    }
    return u8;
  }

  function parseSTL(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var n = dv.getUint32(80, true);
    var verts = [];
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < n; t++) {
      var o = 84 + t * 50 + 12;
      for (var v = 0; v < 3; v++) {
        var x = dv.getFloat32(o + v * 12, true);
        var y = dv.getFloat32(o + v * 12 + 4, true);
        var z = dv.getFloat32(o + v * 12 + 8, true);
        verts.push(x, y, z);
        if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      }
    }
    return { triangles: n, vertices: verts, min: min, max: max };
  }

  /* ---------- ZIP（STORE） ---------- */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function zipStore(files) {
    var chunks = [];
    var central = [];
    var offset = 0;
    function push(arr) { chunks.push(arr); offset += arr.length; }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var name = utf8(f.name);
      var data = f.data;
      var crc = crc32(data);
      var lh = new Uint8Array(30 + name.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);
      lh.set(name, 30);
      var localOffset = offset;
      push(lh); push(data);
      var cd = new Uint8Array(46 + name.length);
      var dv2 = new DataView(cd.buffer);
      dv2.setUint32(0, 0x02014b50, true);
      dv2.setUint16(4, 20, true);
      dv2.setUint16(6, 20, true);
      dv2.setUint16(8, 0, true);
      dv2.setUint16(10, 0, true);
      dv2.setUint16(12, 0, true);
      dv2.setUint16(14, 0x21, true);
      dv2.setUint32(16, crc, true);
      dv2.setUint32(20, data.length, true);
      dv2.setUint32(24, data.length, true);
      dv2.setUint16(28, name.length, true);
      dv2.setUint16(30, 0, true);
      dv2.setUint16(32, 0, true);
      dv2.setUint16(34, 0, true);
      dv2.setUint16(36, 0, true);
      dv2.setUint32(38, 0, true);
      dv2.setUint32(42, localOffset, true);
      cd.set(name, 46);
      central.push(cd);
    }
    var cdStart = offset;
    var cdSize = 0;
    for (var c = 0; c < central.length; c++) { push(central[c]); cdSize += central[c].length; }
    var eocd = new Uint8Array(22);
    var dv3 = new DataView(eocd.buffer);
    dv3.setUint32(0, 0x06054b50, true);
    dv3.setUint16(4, 0, true);
    dv3.setUint16(6, 0, true);
    dv3.setUint16(8, files.length, true);
    dv3.setUint16(10, files.length, true);
    dv3.setUint32(12, cdSize, true);
    dv3.setUint32(16, cdStart, true);
    dv3.setUint16(20, 0, true);
    push(eocd);
    var total = 0;
    for (var q = 0; q < chunks.length; q++) total += chunks[q].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (var r = 0; r < chunks.length; r++) { out.set(chunks[r], at); at += chunks[r].length; }
    return out;
  }

  /* ---------- 3MF ---------- */
  function fmtCoord(v) {
    var s = (Math.round(v * 1e4) / 1e4).toFixed(4);
    return s.replace(/\.?0+$/, '') || '0';
  }

  function write3MF(mesh, opts) {
    opts = opts || {};
    var pos = mesh.positions, idx = mesh.indices;
    var tx = (opts.tx === undefined) ? 128 : opts.tx;
    var ty = (opts.ty === undefined) ? 128 : opts.ty;
    var tz = (opts.tz === undefined) ? 0 : opts.tz;
    var name = opts.name || '五级台';
    var verts = [];
    for (var i = 0; i < pos.length; i += 3) {
      verts.push('<vertex x="' + fmtCoord(pos[i]) + '" y="' + fmtCoord(pos[i + 1]) + '" z="' + fmtCoord(pos[i + 2]) + '"/>');
    }
    var tris = [];
    for (var t = 0; t < idx.length; t += 3) {
      tris.push('<triangle v1="' + idx[t] + '" v2="' + idx[t + 1] + '" v3="' + idx[t + 2] + '"/>');
    }
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      ' <metadata name="Application">FSG 五级台生成器 ' + FSG.VERSION + '</metadata>\n' +
      ' <metadata name="Title">' + name + '</metadata>\n' +
      ' <resources>\n' +
      '  <object id="1" type="model" name="' + name + '">\n' +
      '   <mesh>\n' +
      '    <vertices>\n' + verts.join('\n') + '\n    </vertices>\n' +
      '    <triangles>\n' + tris.join('\n') + '\n    </triangles>\n' +
      '   </mesh>\n' +
      '  </object>\n' +
      ' </resources>\n' +
      ' <build>\n' +
      '  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 ' + fmtCoord(tx) + ' ' + fmtCoord(ty) + ' ' + fmtCoord(tz) + '"/>\n' +
      ' </build>\n' +
      '</model>\n';
    var contentTypes = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
      ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
      ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
      '</Types>\n';
    var rels = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
      ' <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
      '</Relationships>\n';
    return zipStore([
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rels) },
      { name: '3D/3dmodel.model', data: utf8(xml) }
    ]);
  }

  /* 读取 3MF（STORE 或 DEFLATE 之外的简易校验用） */
  function unzipStore(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var files = {};
    var eocdPos = -1;
    for (var i = u8.length - 22; i >= 0 && i > u8.length - 70000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw new Error('EOCD not found');
    var count = dv.getUint16(eocdPos + 10, true);
    var cdOff = dv.getUint32(eocdPos + 16, true);
    var p = cdOff;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header');
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = '';
      for (var q = 0; q < nameLen; q++) name += String.fromCharCode(u8[p + 46 + q]);
      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('bad local header');
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataOff = localOff + 30 + lNameLen + lExtraLen;
      var data = u8.subarray(dataOff, dataOff + compSize);
      if (method !== 0) throw new Error('compressed entry not supported in test reader: ' + name);
      files[name] = data;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /* ---------- 参数导出 ---------- */
  function writeParamsJSON(result, extra) {
    var d = result.derived, a = result.audit;
    var obj = {
      app: '五级台生成器',
      version: FSG.VERSION,
      generatedAt: new Date().toISOString(),
      params: d.params,
      derived: {
        W: d.W, D: d.D, H: d.H,
        zPin: d.zPin, zFloor: d.zFloor,
        levels: d.levels.map(function (lv) {
          return {
            index: lv.i + 1, x: lv.x, yCenter: lv.yc,
            L: lv.L, boreD: lv.boreD, pinD: lv.pinD, pinSlotLength: lv.slotLen
          };
        })
      },
      mesh: {
        vertices: a.vertices, triangles: a.triangles,
        volumeMm3: a.volume, areaMm2: a.area,
        bboxMin: a.bboxMin, bboxMax: a.bboxMax,
        watertight: a.watertight, components: a.components
      },
      extra: extra || null
    };
    return JSON.stringify(obj, null, 2) + '\n';
  }

  function writeParamsTXT(result, extraLines) {
    return FSG.paramsReport(result.derived, extraLines);
  }

  return {
    writeSTL: writeSTL, parseSTL: parseSTL,
    write3MF: write3MF, unzipStore: unzipStore,
    zipStore: zipStore, crc32: crc32,
    writeParamsJSON: writeParamsJSON, writeParamsTXT: writeParamsTXT,
    fmtCoord: fmtCoord
  };
})();
