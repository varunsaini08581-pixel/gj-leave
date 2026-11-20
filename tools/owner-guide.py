#!/usr/bin/env python3
"""Builds the owner page PDF: what to watch, what the system cannot catch. Usage: owner-guide.py OUT.pdf"""
import sys, os, importlib.util
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak

spec = importlib.util.spec_from_file_location('sg', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'staff-guide.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
W = g.W


def build(out):
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm,
                            title='GJ Leave & Attendance - Owner page', author='Genuine Junction')
    s = []
    s += [Paragraph('GENUINE JUNCTION', g.st('k', 10, 13, g.BLUE, 'GJ-B')), g.gap(4),
          Paragraph('GJ Leave &amp; Attendance', g.H0),
          Paragraph('Owner page: aapko kya dekhna hai, aur system kya nahi pakad sakta', g.SUB), g.gap(6)]

    s += g.head('Aapke aur Aakash ke kaam', 'Baaki sab app khud karta hai.')
    s.append(g.row([
        ('Sirf Varun', ['Naye phone approve karna', 'PIN reset (WhatsApp link aapke phone par khulega, Send aap dabaoge)',
                        'Hard rule override, likhi wajah ke saath', 'Dispute ka faisla (rakho ya hatao)',
                        '3 din se zyada ki chhutti mein doosri haan', 'Aakash ki chhutti', 'Settings: log, duty time, salary, rules',
                        'Mahina lock karna'], g.BLUE_BG, g.BLUE),
        ('Aakash', ['Aapka naya phone approve karna, sirf jab aapka phone kho jaye (aapko alert jayega)', 'Chhutti approve / reject', 'Late, early aur going-out approve', 'Wapas aane ko confirm',
                    'Dress flag: confirm ya dismiss', 'Manual violation (photo ya note ke saath)',
                    'Absent ko "humanitarian - excused" karna', 'App band ho to baad mein entry ("entered by Aakash")',
                    'Restricted dates jodna'], g.GREEN_BG, g.GREEN),
    ]))
    s.append(g.gap(10))
    s += g.head('Roz aur mahine mein kya dekhna hai', 'Screen ke naam app ke hisaab se.')
    s.append(g.table(['Kab', 'Kahan', 'Kya dekhna'], [
        ['Roz subah', 'Today at GJ', 'Kaun aaya, photo, dukaan se doori, dress flag'],
        ['Roz', 'Approvals', 'Pending request. 2 ghante mein jawab na ho to Aakash ko dobara yaad dilaya jata hai'],
        ['Jab aaye', 'Devices', 'Naya phone approve karne ki request. Pehle staff se poochh lo ki phone sach mein badla hai'],
        ['Jab aaye', 'Approvals (laal)', 'Kisi ne ek din mein 4 ya zyada request bheji. 6th se seedha aapke paas aati hai. Wajah poochho'],
        ['Jab aaye', 'Disputes', 'Violation par aapatti. 24 ghante ke andar hi aa sakti hai'],
        ['Hafte mein 1 baar', 'Board / Calendar', 'Aane wale hafte mein kaun chhutti par, kahan "possible clash"'],
        ['Mahine ke end mein', 'Month report', 'Har insaan: chhutti, bank, violation, "would be deducted". Override alag se dikhte hain. Phir lock'],
    ], [W * 0.2, W * 0.2, W * 0.6]))
    s.append(PageBreak())
    s += g.head('Savdhaniyan', 'Chalu karne ke baad ye baatein yaad rakho.')
    s.append(g.table(['Baat', 'Kyun'], [
        ['Google Sheet ko haath se edit mat karo', 'App ka hisaab bigad sakta hai. Zaroori badlav Settings se karo. '
                                                   'Haath se kiya badlav app mein 10 minute tak der se dikh sakta hai'],
        ['Sheet ki row kabhi delete mat karo', 'App kuch delete nahi karta; poora itihaas isi par tika hai'],
        ['Apps Script wala Google account aapka hi rahe', 'App usi account ke naam se chalta hai; password badalne se farak nahi, account band hone se app band'],
        ['Speed', 'Screen 2-3 second, check in lagbhag 6 second. Ye Google Apps Script ki seema hai'],
        ['Email alerts', 'Sirf email aur app ke andar. SMS nahi hai. Google ki roz ki email limit hai (lagbhag 100)'],
        ['Rollback', 'Har badlav ka zip Drive ke "GJ Software Backups" mein hai. Purana version Apps Script mein '
                     'Manage deployments se wapas chun sakte ho; link wahi rehta hai'],
        ['Phone kho gaya', 'Naye phone par PIN se sign in karo. Aakash use approve kar sakta hai. Aakash na ho to Apps Script editor mein resetOwnerPhones chalao, phir PIN se sign in'],
        ['Sunday swap', 'App mein alag niyam nahi. Har din par wahi niyam lagte hain. Swap ka hisaab aap haath se theek karte ho (override ya correction)'],
        ['WhatsApp group', 'Pehle din se band. App band ho to staff Aakash ko call ya seedha WhatsApp kare'],
    ], [W * 0.36, W * 0.64]))

    s.append(PageBreak())

    s += g.head('System kya NAHI pakad sakta', 'Ye seemayein asli hain. Inhe jaan kar hi app par bharosa karo.')
    s.append(g.row([
        ('GPS', ['Dukaan ke andar GPS 20 se 60 meter tak galat ho sakta hai. Isliye 50 meter ke bahar wala check in '
                 '<b>roka nahi jata, sirf flag hota hai</b>.',
                 'Fake-GPS app wala phone location jhooth bol sakta hai. Bachav: photo mein dukaan dikhni chahiye.'], g.AMBER_BG, g.AMBER),
        ('Photo', ['Photo app ke andar hi li jati hai, gallery se nahi. Par app ye <b>nahi pehchanta ki photo mein kaun hai</b>. '
                   'Chehra insaan ko hi dekhna hoga ("Today at GJ").',
                   'Koi screen par purani photo dikha kar uski photo le, to app nahi pakdega.'], g.AMBER_BG, g.AMBER),
    ]))
    s.append(g.gap())
    s.append(g.row([
        ('Dress check', ['Ye andaza hai, faisla nahi. Kam roshni, kala coat, door se li photo mein galat ho sakta hai.',
                         'Asli dukaan ki photo par abhi <b>test nahi hua</b>. Pehle hafte ke flag dhyan se dekho.',
                         'App kabhi khud dress violation nahi lagata.'], g.RED_BG, g.RED),
        ('Phone binding', ['Binding browser mein rakhe token se hai, phone ke hardware se nahi.',
                           'Staff browser ka data saaf kare ya doosra browser khole to phone "naya" lagega aur dobara approve karna padega.',
                           'Koi apna PIN <b>aur</b> approved phone dono kisi ko de de, to wo uski jagah kaam kar sakta hai.'], g.AMBER_BG, g.AMBER),
    ]))
    s.append(g.gap())
    s.append(g.row([
        ('Jo cheez app ko dikhti hi nahi', ['Dukaan mein phone/reels, grouping, chai cup, kachra, display photo, job sheet: '
                                           'ye Aakash ko khud dekh kar daalne hain.',
                                           'Koi check in kar ke bina "Going out" dabaye nikal jaye to app ko pata nahi chalega.',
                                           'Check out bhool jaye to din "open" rehta hai; Aakash theek karega.'], g.GREY_BG, g.INK),
        ('Paisa', ['App <b>na salary deta hai, na kaat-ta hai</b>. "Would be deducted" sirf andaza hai.',
                   'Rate = salary ÷ 30 ÷ duty ke ghante. Salary ya duty time galat bhara to andaza bhi galat.',
                   'Salary sirf aapko, Aakash ko aur us insaan ko dikhti hai.'], g.GREEN_BG, g.GREEN),
    ]))

    def footer(c, d):
        c.setFont('GJ', 8)
        c.setFillColor(g.MUTED)
        c.drawString(14 * mm, 8 * mm, 'GJ Leave & Attendance - Owner page')
        c.drawRightString(A4[0] - 14 * mm, 8 * mm, 'Page %d' % d.page)

    doc.build(s, onFirstPage=footer, onLaterPages=footer)


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'GJ_Leave_Owner_Page.pdf')
