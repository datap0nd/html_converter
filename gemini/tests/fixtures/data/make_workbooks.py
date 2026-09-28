# Regenerates the Excel fixtures from sales.csv / products.csv.
# Needs Python 3 with openpyxl (pip install openpyxl); LibreOffice optional for the re-saved copy.
#   python make_workbooks.py
import csv, datetime, os, shutil, subprocess, tempfile
from openpyxl import Workbook
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.workbook.defined_name import DefinedName

here = os.path.dirname(os.path.abspath(__file__))

def rows(name):
    with open(os.path.join(here, name), encoding='utf-8-sig', newline='') as handle:
        return list(csv.reader(handle))

wb = Workbook()
sales = wb.active
sales.title = 'Sales'
data = rows('sales.csv')
sales.append(data[0])
for record in data[1:]:
    order_id, order_date, product, channel, region, quantity, price, discount = record
    sales.append([int(order_id), datetime.date.fromisoformat(order_date), int(product), channel, region, int(quantity), float(price), float(discount)])
for cell in sales['B'][1:]:
    cell.number_format = 'dd/mm/yyyy'

products = wb.create_sheet('Product List')
products['A1'] = 'Product master (maintained by Finance)'
data = rows('products.csv')
for index, record in enumerate(data):
    values = record if index == 0 else [int(record[0]), *record[1:5], float(record[5])]
    products.append(values)
last = 2 + len(data)
products.append([None, None, None, None, 'Total', None])
products[f'F{last}'] = f'=SUBTOTAL(109,F3:F{last - 1})'
table = Table(displayName='Products', ref=f'A2:F{last}', totalsRowCount=1)
table.tableStyleInfo = TableStyleInfo(name='TableStyleMedium2', showRowStripes=True)
products.add_table(table)

notes = wb.create_sheet('Notes')
notes['A1'] = 'Internal'
notes.sheet_state = 'hidden'

targets = wb.create_sheet('Targets')
targets.append(['Region', 'Target', 'Updated'])
targets.append(['West', 1500.5, datetime.datetime(2024, 1, 31, 17, 30)])
targets.append(['East', 1200, datetime.datetime(2024, 1, 31, 0, 0)])
targets.append(['North', '=1/0', datetime.time(8, 15)])
wb.defined_names['RegionTargets'] = DefinedName('RegionTargets', attr_text="Targets!$A$1:$B$4")

out = os.path.join(here, 'sales.xlsx')
wb.save(out)

# A workbook written the way Excel and the Open XML SDK write it (openpyxl writes inline
# strings instead): shared strings with rich text and phonetic runs, "x:"-prefixed
# elements, cells without references, the 1904 date system, error and formula-text cells.
import zipfile
def part(text):
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + text
NS = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
files = {
    '[Content_Types].xml': part('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    '_rels/.rels': part('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': part(f'<x:workbook {NS}><x:workbookPr date1904="1"/><x:sheets><x:sheet name="Regions &amp; Owners" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>'),
    'xl/_rels/workbook.xml.rels': part('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'xl/sharedStrings.xml': part(f'<x:sst {NS} count="6" uniqueCount="6"><x:si><x:t>Region</x:t></x:si><x:si><x:t>Owner</x:t></x:si><x:si><x:t>Since</x:t></x:si><x:si><x:r><x:rPr><x:b/></x:rPr><x:t>West</x:t></x:r><x:r><x:t xml:space="preserve"> Coast</x:t></x:r></x:si><x:si><x:t>&#x6771;&#x4EAC;</x:t><x:rPh sb="0" eb="2"><x:t>TOUKYOU</x:t></x:rPh></x:si><x:si><x:t>A_x000D__x000A_B &lt;tag&gt;</x:t></x:si></x:sst>'),
    'xl/styles.xml': part(f'<x:styleSheet {NS}><x:numFmts count="1"><x:numFmt numFmtId="164" formatCode="[$-409]d\\-mmm\\-yyyy;@"/></x:numFmts><x:cellXfs count="3"><x:xf numFmtId="0"/><x:xf numFmtId="164" applyNumberFormat="1"/><x:xf numFmtId="4" applyNumberFormat="1"/></x:cellXfs></x:styleSheet>'),
    'xl/worksheets/sheet1.xml': part(f'<x:worksheet {NS}><x:dimension ref="B2:E5"/><x:sheetData>'
        '<x:row r="2"><x:c r="B2" t="s"><x:v>0</x:v></x:c><x:c t="s"><x:v>1</x:v></x:c><x:c t="s"><x:v>2</x:v></x:c><x:c r="E2" t="str"><x:f>"Amount"</x:f><x:v>Amount</x:v></x:c></x:row>'
        '<x:row r="3"><x:c r="B3" t="s"><x:v>3</x:v></x:c><x:c r="C3" t="inlineStr"><x:is><x:t>Ann</x:t></x:is></x:c><x:c r="D3" s="1"><x:v>43831</x:v></x:c><x:c r="E3" s="2"><x:v>1234.5</x:v></x:c></x:row>'
        '<x:row r="4"><x:c r="B4" t="s"><x:v>4</x:v></x:c><x:c r="C4" t="b"><x:v>1</x:v></x:c><x:c r="D4" t="d"><x:v>2024-02-29T00:00:00</x:v></x:c><x:c r="E4" t="e"><x:f>1/0</x:f><x:v>#DIV/0!</x:v></x:c></x:row>'
        '<x:row r="5" spans="2:5"/>'
        '<x:row r="6"><x:c r="B6" t="s"><x:v>5</x:v></x:c></x:row>'
        '</x:sheetData></x:worksheet>')
}
with zipfile.ZipFile(os.path.join(here, 'excel-style.xlsx'), 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, text in files.items():
        archive.writestr(name, text)
