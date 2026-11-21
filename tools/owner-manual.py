#!/usr/bin/env python3
"""Owner manual A to Z (only for Varun), simple Hinglish, cards. Usage: owner-manual.py OUT.pdf"""
import importlib.util
import os
import sys

_spec = importlib.util.spec_from_file_location('sg', os.path.join(os.path.dirname(__file__), 'staff-guide.py'))
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak

card, row, steps, table, gap = sg.card, sg.row, sg.steps, sg.table, sg.gap
W, S, H0, SUB = sg.W, sg.S, sg.H0, sg.SUB
BLUE, BLUE_BG, GREEN, GREEN_BG, AMBER, AMBER_BG, RED, RED_BG, GREY_BG, INK = (
    sg.BLUE, sg.BLUE_BG, sg.GREEN, sg.GREEN_BG, sg.AMBER, sg.AMBER_BG, sg.RED, sg.RED_BG, sg.GREY_BG, sg.INK)
SEC_H = ParagraphStyle('secH', parent=sg.H1, keepWithNext=1, spaceBefore=6)
SEC_S = ParagraphStyle('secS', parent=SUB, keepWithNext=1, spaceAfter=8)
LINK = 'https://varunsaini08581-pixel.github.io/gj-leave/'


def section(letter, title, sub):
    return [Paragraph(f'{letter}. {title}', SEC_H), Paragraph(sub, SEC_S)]


def build(out):
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm,
                            title='GJ Leave & Attendance - Owner Manual', author='Genuine Junction')
    s = []
    s.append(Paragraph('GENUINE JUNCTION · SIRF VARUN KE LIYE', sg.st('k', 10, 13, sg.MUTED, 'GJ-B')))
    s.append(Paragraph('GJ Leave &amp; Attendance', H0))
    s.append(Paragraph('Owner Manual, A se Z tak: chalu karna, roz ka kaam, aapke khaas adhikaar, savdhaniyan aur seemayein.', SUB))
    s.append(gap(10))
    s.append(row([
        ('App ka link', [f'<b>{LINK}</b>', 'Yahi link staff ko PIN ke saath jata hai.'], BLUE_BG, BLUE),
        ('Google Sheet', ['Drive mein <b>"GJ Leave"</b>. Isi mein saara data hai.', 'Purani "GJ Leave - TEST" sirf testing ke liye hai.'], GREY_BG, INK),
    ]))
    s.append(gap(8))
    s.append(card('Abhi ki sthiti (21 Nov 2026)', [
        'Server chalu, timers lage hue, staff ki list (naam, group, duty time, roster Sunday) daali hui.',
        '<b>Abhi kisi ka PIN nahi bana, koi phone approve nahi, salary khaali.</b> Ye teeno aap karte ho (Part A).',
        'Absent ki ginti 21 Nov se shuru hai; usse pehle ke din kabhi absent nahi ginenge.'], AMBER_BG, AMBER))
    s.append(gap(14))

    # ---------- A ----------
    s += section('A', 'Pehle din ka setup (aaj)', 'Isi kram mein karo. Lagbhag 30-40 minute, zyadatar staff ke PIN bhejne mein.')
    s.append(steps([
        ('Apna PIN banao (laptop par)', 'Drive mein Sheet "GJ Leave" kholo. Upar menu mein <b>"GJ Leave" &gt; "Set owner PIN"</b>. 4-6 ank ka PIN do baar daalo. '
                                        'Pehli baar Google "Allow" maang sakta hai: dabao. Ye PIN koi aur nahi dekhta.'),
        ('Apne phone par sign in', 'App ka link kholo, "Varun" chuno, PIN daalo, "Sign in". Aapka pehla phone apne aap approve ho jata hai. Phir Home screen par lagao.'),
        ('Aakash ka PIN', 'More &gt; <b>"Set a PIN"</b> &gt; Aakash chuno &gt; "Create new PIN" (do baar tap) &gt; "Open WhatsApp with this message" &gt; Aakash ki chat chuno &gt; Send. PIN sirf ek baar dikhta hai.'),
        ('Baaki 9 staff ke PIN', 'Yahi har ek ke liye. Unke sign in karte hi aapke <b>Approvals</b> mein "New phone" card aayega: staff se seedha poochh kar ki ye unka hi phone hai, <b>"Approve phone"</b>.'),
        ('Dukaan ki location', 'Dukaan ke andar khade ho kar (aap ya Aakash): More &gt; Menu &gt; "Set shop location" &gt; "Set shop location now". '
                               'Iske bina check in mein dukaan se doori nahi dikhegi. Pehli baar ke baad sirf aap badal sakte ho.'),
        ('Salary daalo', 'More &gt; Menu &gt; "People, duty times and pay" &gt; har insaan par "Salary structure": fixed salary, target allowance, discipline bonus, duty ke ghante. '
                         'Saath mein duty time aur roster Sunday ek baar jaanch lo.'),
        ('Team Manual group mein bhejo', '"GJ_Leave_Team_Manual.pdf" bhejo aur bata do: <b>aaj se WhatsApp leave group band</b>, sab kuch app se.'),
        ('Agar koi sale / season aane wala hai', 'More &gt; Menu &gt; "Restrictions (blackout dates)" mein dates daal do, taaki us samay chhutti na mile.'),
    ]))
    s.append(gap(14))

    # ---------- B ----------
    s += section('B', 'Kaun kya karta hai', 'Baaki sab app khud karta hai.')
    s.append(table(['Sirf Varun', 'Aakash'], [
        ['Staff ke PIN banana aur naye phone approve karna', 'Chhutti approve / reject'],
        ['Dispute ka faisla: "Uphold" ya "Remove violation"', 'Late, early aur going-out approve; wapas aane ko confirm'],
        ['Hard rule override, likhi wajah ke saath', 'Dress flag: confirm ya dismiss'],
        ['3 din se zyada ki chhutti mein doosri haan; 6th+ request', 'Manual violation (photo ya note ke saath)'],
        ['Aakash ki apni chhutti', 'Absent ko "Humanitarian – excused" ya "Was at work: take back"'],
        ['People, salary, duty time, Phones, Clash rules, Shop-closed days, Grace table', 'App band ho to baad mein entry ("entered by Aakash")'],
        ['Mahina lock (Aakash ke saath), lock ke baad "Add correction"', 'Restricted dates; pehli baar dukaan ki location'],
        ['', 'Sirf jab aapka phone kho jaye: aapka naya phone approve (aapko alert jata hai)'],
    ], [W / 2, W / 2]))
    s.append(gap(14))

    # ---------- C ----------
    s += section('C', 'Roz, hafte aur mahine mein kya dekhna hai', 'Screen ke naam app ke hisaab se.')
    s.append(table(['Kab', 'Kahan', 'Kya dekhna'], [
        ['Roz subah', 'Today at GJ', 'Kaun aaya, check in photo, dukaan se doori, dress flag, kaun bahar hai'],
        ['Roz', 'Approvals', 'Aapke paas aayi requests. 2 ghante mein jawab na ho to reminder (raat 12-6 nahi)'],
        ['Jab aaye', 'Approvals: "New phone"', 'Staff se poochh kar hi approve. Ek insaan = ek phone'],
        ['Jab aaye', 'Approvals (laal line)', 'Kisi ne ek din mein 4 ya zyada request bheji. Wajah poochho'],
        ['Jab aaye', 'Disputes', 'Violation par aapatti. Note likh kar "Uphold" ya "Remove violation"'],
        ['Hafte mein 1 baar', 'Calendar', 'Aane wale dino mein kaun chhutti par, kahan "possible clash"'],
        ['Mahine ke end mein', 'Month report', 'Har insaan: chhutti, bank, violation, "would be deducted". Overrides alag. Phir aap aur Aakash dono confirm karo: mahina lock'],
    ], [30 * mm, 42 * mm, W - 72 * mm]))
    s.append(gap(6))
    s.append(card('Mahina lock ke baad', [
        'Lock hua mahina jam jata hai: baad ka koi badlav uski ginti nahi chhedta. Galti ho to Month report mein "Add correction" se likh do.',
        'Lock karte hi us mahine ki atki hui requests apne aap band ho jati hain.'], BLUE_BG, BLUE))
    s.append(gap(14))

    # ---------- D ----------
    s += section('D', 'Aapke niyam jo app mein lage hain', 'Ye sab aapke faisle hain; badlav chahiye to mujhe batao.')
    s.append(table(['Niyam', 'Kya hota hai'], [
        ['5 chhutti free / mahina', 'Roster Sunday aur emergency shamil. Upar ka har din = 1 din "would be deducted"'],
        ['Emergency (3-36 ghante pehle)', '2 tak theek. 3rd se har ek = 1 violation + 1 din, free nahi ginti'],
        ['Unannounced / absent', '1 violation (Aakash maaf kar sakta hai)'],
        ['2 ghante ka bank', 'Late (10 min chhoot ke baad), jaldi jana, outing. Bank ke upar har 2 ghante (bata kar) = 1 violation'],
        ['Bina bataye late', '3 baar maaf, 5th/7th/9th = violation; 30 min se zyada = turant violation'],
        ['Outing', 'Din ka pehla outing 15 min tak free, sirf ek baar. Baaki poora bank se'],
        ['Din mein gayab', '2 ghante se zyada = half day, 4.5 ghante se zyada = poora din (sirf chhutti ginti mein)'],
        ['Ladder', '1st violation sirf record, 2nd = ₹500 bonus + target allowance, 3rd = notice'],
        ['Request / din', '4th-5th laal + Aakash; 6th se seedha aap; 7th se alert nahi (Approvals mein rehti hai)'],
        ['Chhutti wale din kaam par aaye', 'Chhutti pehle manzoor thi aur aap/Aakash ne usi din ya baad mein wapas li: us din ka late "bata kar"'],
        ['Sunday swap', 'Alag niyam nahi. Har din par wahi niyam; swap ka hisaab aap haath se theek karte ho (override ya correction)'],
        ['Reminder', 'Pending request har 2 ghante (raat 12-6 nahi). Kal ki chhutti ka reminder shaam ko ek baar'],
    ], [50 * mm, W - 50 * mm]))
    s.append(gap(14))

    # ---------- E ----------
    s += section('E', 'Savdhaniyan', 'Chalu karne ke baad ye baatein yaad rakho.')
    s.append(table(['Baat', 'Kyun'], [
        ['Sheet kisi ke saath share mat karo (Aakash ke saath bhi nahi)', 'Jiske paas edit access hai wo "GJ Leave" menu se aapka PIN badal sakta hai aur sab salary dekh sakta hai'],
        ['Google Sheet ko haath se edit mat karo', 'App ka hisaab bigad sakta hai. Zaroori badlav app ki Settings se karo. Haath ka badlav 10 minute tak der se dikh sakta hai'],
        ['Sheet ki row kabhi delete mat karo', 'App kuch delete nahi karta; poora itihaas isi par tika hai'],
        ['Google account aapka hi rahe', 'App usi account ke naam se chalta hai. Password badalne se farak nahi; account band hone se app band'],
        ['Speed', 'Screen 2-3 second, check in lagbhag 6 second. Ye Google Apps Script ki seema hai'],
        ['Email', 'Sirf email aur app ke andar alert, SMS nahi. Google ki roz ki email seema lagbhag 100'],
    ], [62 * mm, W - 62 * mm]))
    s.append(gap(14))

    # ---------- F ----------
    s += section('F', 'Jab kuch gadbad ho', 'Har cheez ka raasta hai.')
    s.append(table(['Kya hua', 'Kya karo'], [
        ['Aapka phone kho gaya', 'Naye phone par PIN se sign in. Aakash use approve kar sakta hai. Aakash na ho to Sheet mein "GJ Leave" &gt; "Reset owner phones (lost phone)", phir PIN se sign in'],
        ['Aap apna PIN bhool gaye', 'Sheet mein "GJ Leave" &gt; "Set owner PIN" se naya PIN'],
        ['Staff ka PIN / phone', 'More &gt; "Set a PIN" se naya PIN. Purana phone hatana ho to More &gt; Menu &gt; "Phones"'],
        ['Koi violation galat laga', 'Staff 24 ghante mein dispute kare; aap Disputes mein faisla karo'],
        ['Dukaan band rahi (chhutti, bandh)', 'More &gt; Menu &gt; "Shop-closed days" mein din jodo; us din kisi ki ginti nahi hoti. Galti se joda ho to "Remove"'],
        ['App mein naya version chahiye / kuch toot gaya', 'Mujhe batao. Har badlav ka zip Drive ke "GJ Software Backups" mein hai; purana version Apps Script &gt; Manage deployments se wapas chun sakte hain, link wahi rehta hai'],
    ], [52 * mm, W - 52 * mm]))
    s.append(gap(14))

    # ---------- G ----------
    s += section('G', 'System kya NAHI pakad sakta', 'Ye seemayein asli hain. Inhe jaan kar hi app par bharosa karo.')
    s.append(row([
        ('GPS', ['Dukaan ke andar GPS 20 se 60 meter tak galat ho sakta hai, isliye 50 meter ke bahar wala check in roka nahi jata, sirf flag hota hai.',
                 'Fake-GPS app location jhooth bol sakta hai. Bachav: photo mein dukaan dikhni chahiye.'], GREY_BG, INK),
        ('Photo', ['Photo app ke andar hi li jati hai, gallery se nahi. Par app ye nahi pehchanta ki photo mein kaun hai; chehra aapko ya Aakash ko dekhna hai.',
                   'Koi screen par purani photo dikha kar uski photo le to app nahi pakdega.'], GREY_BG, INK),
    ]))
    s.append(gap(6))
    s.append(row([
        ('Dress check', ['Ye andaza hai, faisla nahi. Kam roshni, kala coat, door se li photo mein galat ho sakta hai.',
                         'Asli dukaan ki photo par abhi test nahi hua: pehle hafte ke flag dhyan se dekho. App khud kabhi dress violation nahi lagata.'], AMBER_BG, AMBER),
        ('Phone binding', ['Binding browser mein rakhe token se hai, phone ke hardware se nahi. Browser ka data saaf kiya to phone "naya" lagega.',
                           'Koi apna PIN aur approved phone dono kisi ko de de, to wo uski jagah kaam kar sakta hai.'], AMBER_BG, AMBER),
    ]))
    s.append(gap(6))
    s.append(row([
        ('Jo app ko dikhta hi nahi', ['Phone/reels, grouping, chai cup, kachra, display photo, job sheet: Aakash ko dekh kar daalne hain.',
                                      'Check in ke baad bina "Going out" dabaye nikal jaye to app ko pata nahi chalega.'], RED_BG, RED),
        ('Paisa', ['App na salary deta hai, na kaat-ta hai. "Would be deducted" sirf andaza hai.',
                   'Rate = salary ÷ 30 ÷ duty ke ghante. Salary ya duty time galat bhara to andaza bhi galat.'], RED_BG, RED),
    ]))
    s.append(gap(6))
    s.append(card('Abhi asli phone par jaanchna baaki', [
        'Check in camera (auto-rotate band ho tab), keyboard khulne par neeche ke button, iPhone par home screen ka icon. '
        'Pehle din kuch ajeeb lage to screenshot bhej dena.'], BLUE_BG, BLUE))

    def footer(c, d):
        c.saveState()
        c.setFont('GJ', 8)
        c.setFillColor(sg.MUTED)
        c.drawString(14 * mm, 8 * mm, 'GJ Leave & Attendance - Owner Manual (sirf Varun ke liye)')
        c.drawRightString(A4[0] - 14 * mm, 8 * mm, 'Page %d' % d.page)
        c.restoreState()

    doc.build(s, onFirstPage=footer, onLaterPages=footer)


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'GJ_Leave_Owner_Manual.pdf')
