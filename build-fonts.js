const fs = require('fs');
const path = require('path');

function buildFontJs(ttfPath, vfsName, family, style) {
  const buf = fs.readFileSync(ttfPath);
  const b64 = buf.toString('base64');
  return `(function () {
  var jsPDF = (typeof window !== 'undefined' && window.jspdf && window.jspdf.jsPDF)
    ? window.jspdf.jsPDF
    : (typeof jsPDF !== 'undefined' ? jsPDF : null);
  if (!jsPDF || !jsPDF.API) return;
  var font = '${b64}';
  jsPDF.API.events.push(['addFonts', function () {
    this.addFileToVFS('${vfsName}', font);
    this.addFont('${vfsName}', '${family}', '${style}');
  }]);
})();
`;
}

const dir = __dirname;
const reg = buildFontJs(path.join(dir, 'Inter-Regular.ttf'), 'Inter-Regular.ttf', 'Inter', 'normal');
const bold = buildFontJs(path.join(dir, 'Inter-Bold.ttf'), 'Inter-Bold.ttf', 'Inter', 'bold');

fs.writeFileSync(path.join(dir, 'Inter-Regular-normal.js'), reg);
fs.writeFileSync(path.join(dir, 'Inter-Bold-bold.js'), bold);

console.log('OK: Inter-Regular-normal.js (' + reg.length + ' bytes)');
console.log('OK: Inter-Bold-bold.js (' + bold.length + ' bytes)');
