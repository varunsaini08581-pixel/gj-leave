#!/usr/bin/env python3
"""Builds the staff guide PDF (simple Hinglish, cards). Usage: staff-guide.py OUT.pdf"""
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, KeepTogether)

D = '/usr/share/fonts/truetype/dejavu/'
pdfmetrics.registerFont(TTFont('GJ', D + 'DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('GJ-B', D + 'DejaVuSans-Bold.ttf'))
pdfmetrics.registerFontFamily('GJ', normal='GJ', bold='GJ-B', italic='GJ', boldItalic='GJ-B')

INK = colors.HexColor('#14213D')
MUTED = colors.HexColor('#5B6475')
BLUE = colors.HexColor('#1F4FD8')
BLUE_BG = colors.HexColor('#EAF0FF')
GREEN = colors.HexColor('#12805C')
GREEN_BG = colors.HexColor('#E6F6EF')
AMBER = colors.HexColor('#A15C00')
AMBER_BG = colors.HexColor('#FFF4DC')
RED = colors.HexColor('#B3261E')
RED_BG = colors.HexColor('#FDECEA')
GREY_BG = colors.HexColor('#F3F5F9')
LINE = colors.HexColor('#D5DAE3')

W = A4[0] - 28 * mm


def st(name, size, lead, color=INK, font='GJ', **kw):
    return ParagraphStyle(name, fontName=font, fontSize=size, leading=lead, textColor=color, **kw)


H0 = st('h0', 26, 31, font='GJ-B')
H1 = st('h1', 17, 21, font='GJ-B', spaceAfter=2)
SUB = st('sub', 10.5, 14.5, MUTED)
T = st('t', 11.5, 15, font='GJ-B')
B = st('b', 10, 14)
S = st('s', 9, 12.5, MUTED)
NUM = st('num', 15, 18, colors.white, 'GJ-B', alignment=1)
TH = st('th', 9.5, 12.5, colors.white, 'GJ-B')
TD = st('td', 9.5, 13)


def card(title, lines, bg=GREY_BG, accent=INK, width=W):
    flow = []
    if title:
        flow.append(Paragraph(title, ParagraphStyle('ct', parent=T, textColor=accent)))
        flow.append(Spacer(1, 3))
    for l in lines:
        flow.append(Paragraph(l, B))
    t = Table([[flow]], colWidths=[width])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), bg),
        ('ROUNDEDCORNERS', [7, 7, 7, 7]),
        ('LINEBEFORE', (0, 0), (0, -1), 3, accent),
        ('LEFTPADDING', (0, 0), (-1, -1), 11), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 9), ('BOTTOMPADDING', (0, 0), (-1, -1), 9),
    ]))
    return t


def row(cards, gap=4 * mm):
    n = len(cards)
    cw = (W - gap * (n - 1)) / n
    cells, widths = [], []
    for i, (title, lines, bg, accent) in enumerate(cards):
        cells.append(card(title, lines, bg, accent, cw))
        widths.append(cw)
        if i < n - 1:
            cells.append('')
            widths.append(gap)
    t = Table([cells], colWidths=widths)
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'),
                           ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                           ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    return t


def steps(items, color=BLUE):
    rows = []
    for i, (title, text) in enumerate(items, 1):
        badge = Table([[Paragraph(str(i), NUM)]], colWidths=[9 * mm], rowHeights=[9 * mm])
        badge.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), color), ('ROUNDEDCORNERS', [13, 13, 13, 13]),
                                   ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                   ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                                   ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
        rows.append([badge, [Paragraph(title, T), Paragraph(text, B)]])
    t = Table(rows, colWidths=[14 * mm, W - 14 * mm])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'),
                           ('LINEBELOW', (0, 0), (-1, -2), 0.5, LINE),
                           ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
                           ('LEFTPADDING', (0, 0), (-1, -1), 2)]))
    return t


def table(head, body, widths, head_bg=INK):
    data = [[Paragraph(h, TH) for h in head]] + [[Paragraph(c, TD) for c in r] for r in body]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), head_bg),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, GREY_BG]),
        ('GRID', (0, 0), (-1, -1), 0.5, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
    ]))
    return t


def head(title, sub):
    return [Paragraph(title, H1), Paragraph(sub, SUB), Spacer(1, 8)]


def gap(h=7):
    return Spacer(1, h)


def build(out):
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm,
                            title='GJ Leave & Attendance - Staff Guide', author='Genuine Junction')
    s = []

    # 1 ------------------------------------------------------------------
    s += [Paragraph('GENUINE JUNCTION', st('k', 10, 13, BLUE, 'GJ-B')), gap(4),
          Paragraph('GJ Leave &amp; Attendance', H0),
          Paragraph('Staff guide: app kaise chalana hai, seedhi bhasha mein', SUB), gap(12)]
    s.append(row([
        ('Ab kya badla', ['WhatsApp wala leave group <b>band</b>. Chhutti, late, jaldi jana, bahar jana, '
                          'haazri: sab kuch ab is app se hoga.'], BLUE_BG, BLUE),
        ('Kyun', ['Tareekh pakki, wajah likhi hui, kis ne approve kiya saaf dikhe, aur mahine ka hisaab '
                  'aap khud kabhi bhi dekh sako.'], GREEN_BG, GREEN),
    ]))
    s.append(gap())
    s.append(card('App band ho ya net na chale to', [
        'Aakash sir ko <b>call</b> karo, ya unhe <b>seedha</b> WhatsApp karo (group mein nahi). '
        'Wo baad mein app mein entry kar denge; us par "entered by Aakash" likha aayega.'], AMBER_BG, AMBER))
    s.append(gap(12))
    s += head('Pehli baar: 5 minute ka setup', 'Ye sirf ek baar karna hai, apne khud ke phone par.')
    s.append(steps([
        ('Link kholo', 'Jo link mila hai use Chrome (Android) ya Safari (iPhone) mein kholo.'),
        ('Home screen par lagao', 'Browser ke menu mein "Add to Home screen" dabao. Ab ye app ki tarah khulega.'),
        ('Apna naam chuno aur PIN banao', 'PIN 4 se 6 ank ka. Ye sirf aapko pata hona chahiye. Kisi ko mat batao, '
                                          'kisi aur ke naam se login mat karo.'),
        ('Phone approve hone ka intezaar', 'Pehli baar aapka phone Varun sir approve karenge. Tab tak app '
                                           '"waiting" dikhayega. <b>Ek insaan = ek phone.</b> Naya phone liya to dobara approve hoga.'),
        ('Camera aur Location "Allow" karo', 'Check in ke liye dono zaroori hain. Mana kar diya to check in nahi hoga.'),
    ]))
    s.append(PageBreak())

    # 2 ------------------------------------------------------------------
    s += head('Roz ka kaam: Check in aur Check out', 'Dukaan pahunchte hi Check in, jaate waqt Check out.')
    s.append(steps([
        ('"Check in" dabao', 'Dukaan ke andar, tay ki hui jagah par khade ho kar.'),
        ('Phone ko tedha (landscape) pakdo', 'Sirf peeche wala camera chalega. Selfie ya gallery ki photo nahi chalegi.'),
        ('Photo koi aur le, ya tripod se', 'Frame mein poori dukaan dikhe, aap <b>sir se pair tak</b> dikho. Chehra bahut paas nahi.'),
        ('Photo par stamp apne aap lagega', 'Tareekh, samay, naam, location, dukaan se doori. Samay server ka hota hai, '
                                           'phone ki ghadi badalne se kuch nahi hoga.'),
        ('Shaam ko "Check out"', 'Duty khatam hone par. Jaldi nikle to wo minute ginti mein aayenge (neeche dekho).'),
    ], GREEN))
    s.append(gap(10))
    s.append(row([
        ('Dress (Somvar se Shanivar)', ['Upar <b>safed</b> shirt ya plain kurti (kala coat chalega)',
                                        'Pant <b>kali</b>', 'Joote <b>kale</b>', '<b>Belt</b> lagi ho',
                                        'Ravivar ko casual chalega.'], GREY_BG, INK),
        ('Dress check kaise hota hai', ['App photo dekh kar sirf "Dress OK" ya "Possible issue" batata hai.',
                                        'App <b>khud violation nahi lagata</b>. Aakash sir photo dekh kar tay karte hain.',
                                        'Mahine mein 1 baar ki chhoot hai.'], BLUE_BG, BLUE),
    ]))
    s.append(gap(10))
    s += head('Din mein bahar jana ho', 'Chai, bank, courier, koi bhi kaam.')
    s.append(steps([
        ('"Going out" dabao, wajah aur andaazan samay likho', 'Request Aakash sir ke paas jayegi.'),
        ('Approve hone ke baad niklo', 'Samay Aakash sir ke approve karne se ginta hai.'),
        ('Wapas aate hi "I’m back" dabao', 'Aakash sir confirm karenge. <b>15 minute tak free.</b> 15 se upar gaye '
                                               'to poora samay 2 ghante ke bank se katega.'),
    ], AMBER))
    s.append(PageBreak())

    # 3 ------------------------------------------------------------------
    s += head('Chhutti (leave)', '"Apply for leave" se. Pakki tareekh aur wajah zaroori. "Shayad", "10 ya 11" nahi chalega.')
    s.append(table(['Kitna pehle bataya', 'Kya kehlata hai', 'Asar'], [
        ['36 ghante ya zyada pehle', '<b>Regular</b>', 'Sab theek'],
        ['3 se 36 ghante pehle', '<b>Emergency</b>', 'Mahine mein sirf 2 tak'],
        ['3 ghante se kam, ya duty shuru hone ke baad', '<b>Unannounced</b>', '<font color="#B3261E"><b>1 violation</b></font>'],
        ['Bina bataye nahi aaye', '<b>Absent</b>', '<font color="#B3261E"><b>1 violation</b></font> (sachchi majboori ho to Aakash sir maaf kar sakte hain)'],
    ], [W * 0.38, W * 0.22, W * 0.40]))
    s.append(Paragraph('Ghante aapki duty shuru hone ke samay tak gine jate hain, request bhejne ke samay se.', S))
    s.append(gap(9))
    s.append(row([
        ('Mahine mein 5 chhutti free', ['Is 5 mein aapke <b>roster wale Sunday</b> aur <b>emergency</b> dono shamil hain.',
                                       'Half day = 0.5 (koi bhi 4 ghante 30 minute).',
                                       'Bachi hui chhutti agle mahine nahi judti.'], GREEN_BG, GREEN),
        ('5 se upar gaye to', ['Har extra din = 1 din ki salary <b>kat sakti hai</b>.',
                               'Udaharan: mahine mein 7 chhutti = 2 din.',
                               '<b>3rd emergency</b> (aur uske baad har ek) = 1 violation + 1 din.'], RED_BG, RED),
    ]))
    s.append(gap(9))
    s.append(table(['Aapki request', 'Kaun approve karega'], [
        ['1-2 din, 48 ghante+ pehle, koi clash nahi, 5 ke andar, is mahine koi violation nahi', '<b>Apne aap approve</b>'],
        ['1-2 din, par upar wali koi shart poori nahi', 'Aakash sir'],
        ['Lagataar 3 din', 'Aakash sir, hamesha'],
        ['Lagataar 3 din se zyada', 'Aakash sir <b>aur</b> Varun sir, dono. Ek ne mana kiya to reject'],
    ], [W * 0.62, W * 0.38], BLUE))
    s.append(gap(9))
    s.append(row([
        ('"Not allowed" likha aaye to (clash)', [
            'Dukaan mein kam se kam itne log hone chahiye. Us din koi aur pehle se chhutti par hai to '
            '<b>Send button band</b> rahega aur wajah likhi aayegi.',
            'Jiski request pehle approve hui, tareekh uski. Aakash sir se baat karo, tareekh badlo.'], AMBER_BG, AMBER),
        ('Restricted dates', [
            'Season ya sale ke dino mein chhutti band ho sakti hai. Ye dates form bharne se pehle hi dikhti hain.',
            'Jahan "allowed" likha ho wahan chhutti milegi, par wo <b>1 violation</b> ginegi.'], GREY_BG, INK),
    ]))
    s.append(gap(6))
    s.append(Paragraph('Tareekh badalni ya cancel karni ho to "My requests" mein jao. Naya message mat bhejo; '
                       'badlav par saari jaanch dobara hoti hai. Approve ho chuki chhutti badli to wo dobara Aakash sir ke paas jayegi. '
                       'Half day ke liye bhi notice aapki duty shuru hone ke samay tak gina jata hai.', S))
    s.append(PageBreak())

    # 4 ------------------------------------------------------------------
    s += head('Late, jaldi jana: "2 ghante ka bank"',
              'Har mahine aapke paas 120 minute hain. 1 tareekh ko dobara 120 ho jate hain.')
    s.append(table(['Kya hua', 'Kya ginega'], [
        ['10 minute tak late', 'Kuch nahi (roz ki chhoot)'],
        ['10 minute se zyada late', '10 ke baad wale minute bank se. 22 min late = 12 min'],
        ['Duty khatam hone se pehle nikle', 'Jitna jaldi nikle utne minute bank se'],
        ['Bahar gaye, 15 min tak', 'Free'],
        ['Bahar gaye, 15 min se zyada', 'Poora samay bank se'],
        ['Ek din mein 2 ghante se zyada gayab', '<b>Half day</b> chhutti (4.5 ghante se zyada = poora din)'],
    ], [W * 0.45, W * 0.55]))
    s.append(gap(9))
    s.append(card('"Bataya hua" (informed) ka matlab', [
        '<b>Late:</b> duty shuru hone se <b>pehle</b> app mein "I will be late" bhejo, pahunchne ka samay likh kar.',
        '<b>Jaldi jana:</b> nikalne se <b>pehle</b> "I will leave early" bhejo, samay likh kar.',
        'Dono request <b>Aakash sir approve</b> karte hain. Reject hui to wo minute "bina bataye" ginenge.',
        'Jo samay likha us se zyada late hue, ya likhe samay se pehle nikal gaye, to utne extra minute "bina bataye" ginenge.',
    ], BLUE_BG, BLUE))
    s.append(gap(9))
    s.append(row([
        ('Bata kar', ['Bank ke andar: sirf minute kat-te hain.',
                      'Bank khatam: extra minute ka paisa kat sakta hai.',
                      'Bank ke upar har 2 ghante = <b>1 violation</b>.'], GREEN_BG, GREEN),
        ('Bina bataye (30 min tak)', ['Minute bank se kat-te hain.',
                                     'Mahine mein <b>3 baar maaf</b> (bus, train).',
                                     '4th baar chetavni; <b>5th, 7th, 9th</b> baar = 1 violation.'], AMBER_BG, AMBER),
        ('Bina bataye, 30 min se zyada', ['<b>Turant 1 violation.</b>',
                                         'Sachchi emergency ho to Aakash sir ko phone karo; wo "called - emergency" likh denge.'], RED_BG, RED),
    ]))
    s.append(gap(9))
    s.append(card('Minute ka paisa kaise nikalta hai (sirf andaza)', [
        'Mahine ki salary ÷ 30 ÷ aapki duty ke ghante = 1 ghante ka rate.',
        'Udaharan: ₹17,000 aur 9 ghante ki duty = lagbhag ₹63 ghanta, yani ₹1.05 minute. '
        'Bank ke upar 35 minute = lagbhag ₹37.',
    ], GREY_BG, INK))
    s.append(gap(9))
    s.append(card('App pehle hi bata deta hai', [
        'Request bhejne se pehle screen par likha aata hai: "This uses 22 min. Bank left after this: 18 min." '
        'ya "This will be your 4th not-informed late. The 5th = violation." Bhejne se pehle padh lo.',
    ], GREEN_BG, GREEN))
    s.append(PageBreak())

    # 5 ------------------------------------------------------------------
    s += head('Violation: mahine mein kitne hue to kya', 'Ginti har mahine ki 1 tareekh ko zero se shuru hoti hai.')
    s.append(row([
        ('1st', ['Sirf <b>record</b> mein. Kuch nahi kat-ta.'], GREEN_BG, GREEN),
        ('2nd', ['<b>₹500 discipline bonus</b> aur <b>target allowance</b> dono ja sakte hain, target poora ho tab bhi.'], AMBER_BG, AMBER),
        ('3rd', ['<b>Notice.</b> Faisla Varun sir ka.'], RED_BG, RED),
    ]))
    s.append(gap(9))
    s.append(table(['Violation kis se banta hai', 'Kaun lagata hai'], [
        ['Unannounced chhutti, bina bataye absent', 'App, apne aap'],
        ['Mahine ki 3rd (ya uske baad) emergency', 'App, apne aap'],
        ['Bina bataye late: 5th, 7th, 9th baar; ya 30 min se zyada', 'App, apne aap'],
        ['Bank ke upar har 2 ghante (bata kar)', 'App, apne aap'],
        ['Restricted dino mein li gayi chhutti', 'App, apne aap'],
        ['Dress, display photo, job sheet, inventory list, chai cup, kachra, phone/reels, grouping',
         'Aakash sir, photo ya note ke saath (kuch cheezon mein chhoot ke baad)'],
    ], [W * 0.62, W * 0.38]))
    s.append(gap(9))
    s.append(card('Violation galat laga ho to', [
        '"My month" mein us violation par <b>"Dispute (within 24 hours)"</b> dabao aur apni baat likho. '
        'Varun sir khud dekh kar use rakhenge ya hata denge. 24 ghante ke baad dispute nahi hoga.'], BLUE_BG, BLUE))
    s.append(gap(12))
    s += head('"My month": apna poora hisaab', 'Kabhi bhi khol kar dekho. Mahine ke end mein koi surprise nahi.')
    s.append(row([
        ('Yahan kya dikhta hai', ['Kitni chhutti li, kitni bachi', 'Bank ke kitne minute use hue',
                                  'Kitne violation, kis wajah se', '"Would be deducted": andaze ki rakam, poore hisaab ke saath'],
         GREY_BG, INK),
        ('Zaroori baat', ['App <b>na salary deta hai, na kaat-ta hai</b>. Wo sirf andaza dikhata hai. '
                          'Asli faisla Varun sir aur Aakash sir ka hai.',
                          'Aapki salary ki jaankari sirf aapko, Varun sir aur Aakash sir ko dikhti hai. Kisi aur staff ko nahi.'],
         GREEN_BG, GREEN),
    ]))
    s.append(gap(12))
    s.append(card('5 baatein yaad rakho', [
        '1. Late ho rahe ho? Duty shuru hone se <b>pehle</b> app mein daal do.',
        '2. Chhutti kam se kam <b>48 ghante pehle</b> daalo, to aksar apne aap approve ho jati hai.',
        '3. Bahar jao to "Going out", aao to "I’m back". 15 minute ke andar raho.',
        '4. Check in photo: phone tedha, peeche ka camera, sir se pair tak.',
        '5. Group mein message nahi. App na chale to Aakash sir ko call.',
    ], AMBER_BG, AMBER))

    def footer(c, d):
        c.setFont('GJ', 8)
        c.setFillColor(MUTED)
        c.drawString(14 * mm, 8 * mm, 'GJ Leave & Attendance - Staff guide')
        c.drawRightString(A4[0] - 14 * mm, 8 * mm, 'Page %d' % d.page)

    doc.build(s, onFirstPage=footer, onLaterPages=footer)


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'GJ_Leave_Staff_Guide.pdf')
