#!/usr/bin/env python3
"""Team manual A to Z (staff + Aakash), simple Hinglish, cards. Usage: team-manual.py OUT.pdf"""
import importlib.util
import os
import sys

_spec = importlib.util.spec_from_file_location('sg', os.path.join(os.path.dirname(__file__), 'staff-guide.py'))
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak, KeepTogether

card, row, steps, table, head, gap = sg.card, sg.row, sg.steps, sg.table, sg.head, sg.gap
W, B, S, H0, SUB = sg.W, sg.B, sg.S, sg.H0, sg.SUB
BLUE, BLUE_BG, GREEN, GREEN_BG, AMBER, AMBER_BG, RED, RED_BG, GREY_BG, INK = (
    sg.BLUE, sg.BLUE_BG, sg.GREEN, sg.GREEN_BG, sg.AMBER, sg.AMBER_BG, sg.RED, sg.RED_BG, sg.GREY_BG, sg.INK)

LINK = 'https://varunsaini08581-pixel.github.io/gj-leave/'


from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Spacer
SEC_H = ParagraphStyle('secH', parent=sg.H1, keepWithNext=1, spaceBefore=6)
SEC_S = ParagraphStyle('secS', parent=SUB, keepWithNext=1, spaceAfter=8)


def section(letter, title, sub):
    # The heading always stays on the same page as the first block under it.
    return [Paragraph(f'{letter}. {title}', SEC_H), Paragraph(sub, SEC_S)]


def build(out):
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm,
                            title='GJ Leave & Attendance - Team Manual', author='Genuine Junction')
    s = []

    # ---------- cover ----------
    s.append(Paragraph('GENUINE JUNCTION', sg.st('k', 10, 13, sg.MUTED, 'GJ-B')))
    s.append(Paragraph('GJ Leave &amp; Attendance', H0))
    s.append(Paragraph('Team Manual, A se Z tak: sab staff aur Aakash sir ke liye. 21 November 2026 se lagu.', SUB))
    s.append(gap(10))
    s.append(row([
        ('Ab kya badla', ['WhatsApp wala leave group <b>band</b>.', 'Chhutti, late, jaldi jana, bahar jana, haazri: sab kuch ab is app se.'], BLUE_BG, BLUE),
        ('Kyun', ['Tareekh pakki, wajah likhi hui, kis ne approve kiya saaf dikhe.', 'Mahine ka poora hisaab aap khud kabhi bhi dekh sako.'], GREEN_BG, GREEN),
    ]))
    s.append(gap(8))
    s.append(card('App ka link', [f'<b>{LINK}</b>', 'Ye link Varun sir aapke PIN ke saath WhatsApp par bhejenge.'], GREY_BG, INK))
    s.append(gap(8))
    s.append(card('Is manual mein kya hai', [
        '<b>A.</b> Pehli baar shuru karna &nbsp; <b>B.</b> App ki screens &nbsp; <b>C.</b> Check in aur check out',
        '<b>D.</b> Bahar jana (Going out) &nbsp; <b>E.</b> Late aana, jaldi jana &nbsp; <b>F.</b> Chhutti',
        '<b>G.</b> 2 ghante ka bank &nbsp; <b>H.</b> Violation &nbsp; <b>I.</b> My month aur dispute',
        '<b>J.</b> Jab kuch gadbad ho &nbsp; <b>K.</b> Aakash sir ke kaam &nbsp; <b>L.</b> Yaad rakhne wali 10 baatein',
    ], GREY_BG, INK))
    s.append(gap(8))
    s.append(card('App band ho ya net na chale to', [
        'Aakash sir ko call karo, ya unhe seedha WhatsApp karo (group mein nahi). Wo baad mein app mein entry kar denge; '
        'us par "entered by Aakash" likha aayega. Is wajah se aapka koi nuksaan nahi hoga.'], AMBER_BG, AMBER))
    s.append(PageBreak())

    # ---------- A ----------
    s += section('A', 'Pehli baar shuru karna', 'Sirf ek baar, apne khud ke phone par. Lagbhag 5 minute.')
    s.append(steps([
        ('Varun sir ka WhatsApp message kholo', 'Usme aapka naam, aapka PIN aur app ka link hoga. PIN aap khud nahi banate; Varun sir banate hain.'),
        ('Link kholo', 'Android par Chrome mein, iPhone par Safari mein.'),
        ('Home screen par lagao', 'Android: Chrome ka menu (teen bindu) &gt; "Add to Home screen" ya "Install app". '
                                  'iPhone: Safari ka Share button &gt; "Add to Home Screen". Ab ye app ki tarah khulega.'),
        ('Apna naam chuno, PIN daalo, "Sign in" dabao', 'Galat PIN 5 baar daala to kuch der ke liye lock ho jayega. Bar bar koshish mat karo; Varun sir se naya PIN lo.'),
        ('Phone approve hone ka intezaar', 'Pehli baar aapka phone Varun sir approve karenge. Tab tak app "waiting" dikhayega. Approve hone ke baad dobara "Sign in" dabao.'),
        ('Camera aur Location ko "Allow" karo', 'Check in ke liye dono zaroori hain. Mana kar diya to check in nahi hoga.'),
    ]))
    s.append(gap(8))
    s.append(row([
        ('PIN ke niyam', ['PIN sirf aapko pata ho. Kisi ko mat batao.', 'Kisi aur ke naam se kabhi sign in mat karo.', 'PIN bhool gaye: Varun sir naya PIN bhejenge, purana band ho jayega.'], RED_BG, RED),
        ('Ek insaan, ek phone', ['Naya phone liya, ya browser ka data saaf kiya, to phone "naya" lagega aur dobara approve hoga.',
                                 'Phone kisi aur ko dena ho to pehle More &gt; "Sign out".'], BLUE_BG, BLUE),
    ]))
    s.append(gap(14))

    # ---------- B ----------
    s += section('B', 'App ki screens', 'Neeche tab bar mein ye hisse hote hain. App ki saari likhawat English mein hai.')
    s.append(table(['Tab', 'Kya milta hai'], [
        ['<b>Today</b>', 'Check in, Check out, "Going out", "I will be late", "I will leave early", aaj ke alert.'],
        ['<b>Apply</b>', '"Apply for leave": chhutti ki request, aur "My requests" mein apni purani requests (badlo ya cancel karo).'],
        ['<b>My month</b>', 'Is mahine ki chhutti, bank ke minute, violation, "would be deducted". Purane mahine bhi.'],
        ['<b>Approvals</b>', 'Sirf Aakash sir aur Varun sir ke phone par. Sab requests yahan aati hain.'],
        ['<b>More</b>', 'Notifications, "Sign out". Aakash sir aur Varun sir ke liye yahan pura Menu hai.'],
    ], [32 * mm, W - 32 * mm]))
    s.append(gap(8))
    s.append(card('Alert kaise milte hain', [
        'App ke andar (Today aur More &gt; Notifications) aur email par. SMS nahi aata.',
        'Raat 12 se subah 6 baje tak koi reminder nahi jata. Kal ki chhutti ka reminder shaam ko ek baar aata hai.'], GREY_BG, INK))
    s.append(gap(10))

    # ---------- C ----------
    s += section('C', 'Check in aur check out', 'Dukaan pahunchte hi Check in, jaate waqt Check out.')
    s.append(steps([
        ('"Check in" dabao', 'Dukaan ke andar, tay ki hui jagah par khade ho kar.'),
        ('Phone tedha (landscape) pakdo', 'Sirf peeche wala camera chalega. Selfie ya gallery ki photo nahi chalegi.'),
        ('Photo koi aur le, ya tripod se', 'Frame mein dukaan dikhe, aap sir se pair tak dikho. Chehra bahut paas nahi.'),
        ('Stamp apne aap lagta hai', 'Tareekh, samay, naam, location, dukaan se doori. Samay server ka hota hai; phone ki ghadi badalne se kuch nahi hoga.'),
        ('Shaam ko "Check out"', 'Duty khatam hone par. Jaldi nikle to wo minute ginti mein aate hain (Part E).'),
    ]))
    s.append(gap(6))
    s.append(row([
        ('Dress (Somvar se Shanivar)', ['Upar safed shirt ya plain kurti (kala coat chalega).', 'Pant kali, joote kale, belt lagi ho.', 'Ravivar ko casual chalega.'], GREY_BG, INK),
        ('Dress check kaise hota hai', ['App photo dekh kar sirf "Dress OK" ya "Possible issue" batata hai.', 'App khud violation nahi lagata; Aakash sir photo dekh kar tay karte hain. Mahine mein 1 baar ki chhoot.'], BLUE_BG, BLUE),
    ]))
    s.append(gap(6))
    s.append(card('Net na chale ya photo na jaye', [
        'Photo phone mein sambhal kar rakhi jati hai aur "Send again" button aata hai. Net aate hi dabao.',
        'Ye photo sirf usi din aur sirf aapke naam ke liye chalti hai.'], AMBER_BG, AMBER))
    s.append(gap(14))

    # ---------- D ----------
    s += section('D', 'Din mein bahar jana (Going out)', 'Chai, bank, courier, koi bhi kaam.')
    s.append(steps([
        ('"Going out" dabao', 'Wajah aur andaazan samay likho, phir "Ask Aakash". Request Aakash sir ke paas jati hai.'),
        ('Approve hone ke baad niklo', 'Samay Aakash sir ke approve karne se ginta hai.'),
        ('Wapas aate hi "I’m back" dabao', 'Aakash sir confirm karenge. Bhool gaye to Aakash sir sahi samay daal kar band karenge.'),
    ]))
    s.append(gap(6))
    s.append(row([
        ('Free', ['Din ka <b>pehla</b> chhota outing (15 minute tak). Sirf ek baar.'], GREEN_BG, GREEN),
        ('Bank se katega', ['Usi din doosra outing, chahe chhota ho.', '15 minute se upar ka outing: <b>poora</b> samay.', 'Duty se pehle ya baad ka samay nahi ginta.'], AMBER_BG, AMBER),
    ]))
    s.append(gap(10))

    # ---------- E ----------
    s += section('E', 'Late aana, jaldi jana', '"Bataya hua" (informed) aur "bina bataye" ka farak bahut bada hai.')
    s.append(table(['Kya karna hai', 'Kab', 'Kaise'], [
        ['Late aana', '<b>Duty shuru hone se pehle</b>', 'Today &gt; "I will be late", pahunchne ka samay likh kar'],
        ['Jaldi jana', '<b>Check out se pehle</b>', 'Today &gt; "I will leave early", nikalne ka samay likh kar. Check out ke baad bheji request nahi chalegi'],
    ], [30 * mm, 42 * mm, W - 72 * mm]))
    s.append(gap(6))
    s.append(card(None, [
        'Dono request <b>Aakash sir approve karte hain</b>. Approve hui to "bata kar"; reject hui ya pending reh gayi to "bina bataye".',
        'Likhe samay se zyada late hue, ya likhe samay se pehle nikle, to utne extra minute "bina bataye" ginenge.',
        'Ek din mein late/jaldi ki request 5 baar tak badal sakte ho; sirf agle 14 din ke liye bhej sakte ho.',
        'Sachchi emergency (bus, train) ho to Aakash sir ko phone karo; wo "called" likh kar entry karenge.'], GREY_BG, INK))
    s.append(gap(14))

    # ---------- F ----------
    s += section('F', 'Chhutti (leave)', 'Apply &gt; "Apply for leave". Pakki tareekh aur wajah zaroori. "Shayad" ya "10 ya 11" nahi chalega.')
    s.append(table(['Kitna pehle bataya', 'Kya kehlata hai', 'Asar'], [
        ['36 ghante ya zyada pehle', 'Regular', 'Sab theek'],
        ['3 se 36 ghante pehle', 'Emergency', 'Mahine mein sirf 2 tak theek'],
        ['3 ghante se kam, ya duty shuru hone ke baad', 'Unannounced', '1 violation'],
        ['Bina bataye nahi aaye', 'Absent', '1 violation (sachchi majboori ho to Aakash sir maaf kar sakte hain)'],
    ], [60 * mm, 34 * mm, W - 94 * mm]))
    s.append(Paragraph('Ghante aapki duty shuru hone ke samay tak gine jate hain, request bhejne ke samay se. Half day ke liye bhi yahi.', S))
    s.append(gap(6))
    s.append(row([
        ('Mahine mein 5 chhutti free', ['Isme roster wale Sunday aur emergency dono shamil.', 'Half day = 0.5 (koi bhi 4 ghante 30 minute).', 'Bachi hui chhutti agle mahine nahi judti.'], GREEN_BG, GREEN),
        ('5 se upar', ['Har extra din = 1 din ki salary "would be deducted".', '3rd emergency (aur uske baad har ek) = 1 violation + 1 din.'], RED_BG, RED),
    ]))
    s.append(gap(6))
    s.append(table(['Aapki request', 'Kaun approve karega'], [
        ['1-2 din, 48 ghante+ pehle, koi clash nahi, 5 ke andar, is mahine koi violation nahi', 'Apne aap approve'],
        ['1-2 din, par upar wali koi shart poori nahi', 'Aakash sir'],
        ['Lagataar 3 din', 'Aakash sir'],
        ['Lagataar 3 din se zyada', 'Aakash sir aur Varun sir, dono. Ek ne mana kiya to reject'],
    ], [W - 62 * mm, 62 * mm]))
    s.append(gap(6))
    s.append(row([
        ('"Not allowed" aaye to (clash)', ['Dukaan mein kam se kam itne log hone chahiye. Us din koi aur pehle se chhutti par hai to "Send request" band rahega aur wajah likhi aayegi.', 'Jiski request pehle approve hui, tareekh uski. Aakash sir se baat karo.'], AMBER_BG, AMBER),
        ('Restricted dates', ['Season ya sale ke dino mein chhutti band ho sakti hai. Ye dates form mein pehle hi dikhti hain.', 'Jahan "allowed" likha ho wahan chhutti milegi, par 1 violation ginegi.'], AMBER_BG, AMBER),
    ]))
    s.append(gap(6))
    s.append(card('Badalna ya cancel karna', [
        'Apply &gt; "My requests" mein apni request par "Edit" ya "Cancel". Naya message mat bhejo; badlav par saari jaanch dobara hoti hai.',
        'Approve ho chuki chhutti badli to wo dobara Aakash sir ke paas jayegi. Ek request 10 baar tak badal sakte ho.'], GREY_BG, INK))
    s.append(gap(6))
    s.append(card('Ek din mein bahut saari request', [
        'Ek din mein <b>3 request</b> tak sab normal.',
        '<b>4th aur 5th</b>: laal (red) chetavni, aur wo hamesha Aakash sir ki manzoori mein jayegi.',
        '<b>6th se</b>: seedha Varun sir ke paas. Dekha jayega ki kya baat hai.'], RED_BG, RED))
    s.append(gap(14))

    # ---------- G ----------
    s += section('G', '2 ghante ka bank', 'Har mahine aapke paas 120 minute hain. 1 tareekh ko dobara 120 ho jate hain.')
    s.append(table(['Kya hua', 'Kya ginega'], [
        ['10 minute tak late', 'Kuch nahi (roz ki chhoot)'],
        ['10 minute se zyada late', '10 ke baad wale minute. 22 min late = 12 min'],
        ['Duty khatam hone se pehle nikle', 'Jitna jaldi nikle utne minute'],
        ['Bahar gaye, 15 min tak (din mein pehli baar)', 'Free'],
        ['Usi din doosri baar bahar, ya 15 min se zyada', 'Poora samay'],
        ['Ek din mein 2 ghante se zyada gayab', 'Half day chhutti (4.5 ghante se zyada = poora din)'],
    ], [W - 70 * mm, 70 * mm]))
    s.append(gap(6))
    s.append(row([
        ('Bata kar', ['Bank ke andar: sirf minute kat-te hain.', 'Bank khatam: extra minute ka paisa "would be deducted".', 'Bank ke upar har 2 ghante = 1 violation.'], GREEN_BG, GREEN),
        ('Bina bataye (30 min tak)', ['Minute bank se kat-te hain.', 'Mahine mein 3 baar maaf.', '4th baar chetavni; 5th, 7th, 9th baar = 1 violation.'], AMBER_BG, AMBER),
        ('Bina bataye, 30 min se zyada', ['Turant 1 violation.'], RED_BG, RED),
    ]))
    s.append(gap(6))
    s.append(card('Minute ka paisa (sirf andaza)', [
        'Mahine ki salary ÷ 30 ÷ aapki duty ke ghante = 1 ghante ka rate.',
        'App request bhejne se pehle hi bata deta hai, jaise "This uses 22 min. Bank left after this: 18 min." Bhejne se pehle padh lo.'], GREY_BG, INK))
    s.append(gap(10))

    # ---------- H ----------
    s += section('H', 'Violation', 'Ginti har mahine ki 1 tareekh ko zero se shuru hoti hai.')
    s.append(row([
        ('1st', ['Sirf record mein. Kuch nahi kat-ta.'], GREEN_BG, GREEN),
        ('2nd', ['₹500 discipline bonus aur target allowance dono ja sakte hain, target poora ho tab bhi.'], AMBER_BG, AMBER),
        ('3rd', ['Notice. Faisla Varun sir ka.'], RED_BG, RED),
    ]))
    s.append(gap(6))
    s.append(table(['Violation kis se banta hai', 'Kaun lagata hai'], [
        ['Unannounced chhutti, bina bataye absent', 'App, apne aap'],
        ['Mahine ki 3rd (ya uske baad) emergency', 'App, apne aap'],
        ['Bina bataye late/jaldi: 5th, 7th, 9th baar; ya 30 min se zyada', 'App, apne aap'],
        ['Bank ke upar har 2 ghante (bata kar)', 'App, apne aap'],
        ['Restricted dino mein li gayi chhutti', 'App, apne aap'],
        ['Dress, display photo, job sheet, inventory list, chai cup, kachra, phone/reels, grouping', 'Aakash sir, photo ya note ke saath'],
    ], [W - 62 * mm, 62 * mm]))
    s.append(gap(14))

    # ---------- I ----------
    s += section('I', 'My month aur dispute', 'Kabhi bhi khol kar dekho. Mahine ke end mein koi surprise nahi.')
    s.append(row([
        ('Yahan kya dikhta hai', ['Kitni chhutti li, kitni bachi.', 'Bank ke kitne minute use hue.', 'Kitne violation, kis wajah se.', '"Would be deducted": andaze ki rakam, poore hisaab ke saath.'], BLUE_BG, BLUE),
        ('Zaroori baat', ['App na salary deta hai, na kaat-ta hai. Wo sirf andaza dikhata hai; asli faisla Varun sir aur Aakash sir ka.',
                          'Aapki salary ki jaankari sirf aapko, Varun sir aur Aakash sir ko dikhti hai. Kisi aur staff ko nahi.'], GREY_BG, INK),
    ]))
    s.append(gap(6))
    s.append(card('Violation galat laga ho to', [
        '"My month" mein us violation par "Dispute (within 24 hours)" dabao aur apni baat likho.',
        'Varun sir khud dekh kar use rakhenge ya hata denge. 24 ghante ke baad dispute nahi hoga.'], AMBER_BG, AMBER))
    s.append(gap(10))

    # ---------- J ----------
    s += section('J', 'Jab kuch gadbad ho', 'Ghabrao mat. Har cheez ka raasta hai.')
    s.append(table(['Kya hua', 'Kya karo'], [
        ['App nahi khul raha / net nahi', 'Aakash sir ko call ya seedha WhatsApp. Wo baad mein entry karenge.'],
        ['Check in ki photo nahi gayi', '"Send again" dabao jab net aaye.'],
        ['Phone ka camera kharab', 'Aakash sir "Enter a check-in" se aapki haazri daalenge.'],
        ['Check out bhool gaye', 'Aakash sir "Enter a forgotten check-out" se sahi samay daalenge.'],
        ['Galti se jaldi check out ho gaya', 'Aakash sir ko batao; wo use wapas le sakte hain.'],
        ['"I’m back" bhool gaye', 'Aakash sir sahi samay daal kar outing band karenge.'],
        ['PIN bhool gaye ya lock ho gaya', 'Varun sir naya PIN bhejenge.'],
        ['Naya phone liya', 'Naye phone par sign in karo; Varun sir approve karenge.'],
        ['"Update needed" ya "being updated" dikhe', 'App band karke dobara kholo. Thodi der baad phir try karo.'],
        ['Absent laga par aap dukaan par the', 'Aakash sir "Was at work: take back" se hata denge.'],
    ], [62 * mm, W - 62 * mm]))
    s.append(gap(14))

    # ---------- K ----------
    s += section('K', 'Aakash sir ke kaam', 'Approvals tab aur More &gt; Menu. Staff ye hissa sirf jaankari ke liye padhe.')
    s.append(table(['Approvals mein kya aata hai', 'Kya karna hai'], [
        ['Chhutti ki request', '"Approve" ya "Reject" (wajah ke saath). Card par likha hota hai kyun aapke paas aayi. <b>Laal line</b> = us din 4th ya zyada request: wajah poochho'],
        ['"I will be late" / "I will leave early"', 'Approve ya Reject. Isi se tay hota hai ki minute "bata kar" ginenge ya nahi'],
        ['"Going out"', 'Approve karo; samay yahin se ginta hai. Wapas aane par "Confirm back". Bhool gaye ho to sahi samay daal kar "Close this outing"'],
        ['Absent (raat ka check)', '"Keep as absent", "Humanitarian – excused" (sachchi majboori), ya "Was at work: take back" (galti se laga)'],
        ['Dress flag', 'Photo dekh kar "Confirm" ya "Dismiss". App khud kabhi dress violation nahi lagata'],
        ['Varun sir ka naya phone', 'Sirf tab "Approve phone" karo jab Varun sir ne khud phone ya call par bataya ho ki unka phone badla hai'],
    ], [58 * mm, W - 58 * mm]))
    s.append(gap(6))
    s.append(table(['More &gt; Menu', 'Kab kaam aata hai'], [
        ['Today at GJ', 'Roz subah: kaun aaya, check in photo, dukaan se doori, dress flag, kaun bahar hai'],
        ['Record a violation / incident', 'Dress, chai cup, kachra, phone/reels wagaira. Photo ya note zaroor lagao'],
        ['Enter leave for a staff member', 'Kisi ne phone par chhutti batayi aur app nahi chala'],
        ['Staff leaves: cancel or shorten', 'Chhutti ka koi din wapas lena (bulaya, jaldi aa gaya)'],
        ['Enter a check-in / Enter a forgotten check-out', 'Camera kharab, net nahi, ya check out bhool gaye'],
        ['Calendar', 'Aane wale dino mein kaun chhutti par hai'],
        ['Month report', 'Mahine ke end mein sabka hisaab. Lock Varun sir aur aap dono ke confirm karne par hota hai'],
        ['Restrictions (blackout dates)', 'Sale ya season ke din jab chhutti band karni ho'],
        ['Set shop location', 'Pehli baar dukaan ke andar khade ho kar. Uske baad sirf Varun sir badal sakte hain'],
    ], [58 * mm, W - 58 * mm]))
    s.append(gap(6))
    s.append(card('Aakash sir ke liye yaad rakhne wali baatein', [
        'Pending request ka reminder har 2 ghante aata hai (raat 12 se 6 nahi). Jaldi jawab do; staff ka din usi par tika hai.',
        'Aapki apni chhutti Varun sir approve karte hain. Aapki apni request aapke Approvals mein nahi dikhti.',
        'Staff ki baat sun kar hi kuch hatao; har badlav ka record (Audit) rehta hai.'], BLUE_BG, BLUE))
    s.append(gap(14))

    # ---------- L ----------
    s += section('L', 'Yaad rakhne wali 10 baatein', 'Ye 10 yaad rahi to kabhi dikkat nahi hogi.')
    s.append(steps([
        ('Late ho rahe ho?', 'Duty shuru hone se pehle app mein "I will be late" daal do.'),
        ('Jaldi jana hai?', 'Check out se pehle "I will leave early" bhejo.'),
        ('Chhutti 48 ghante pehle', 'To aksar apne aap approve ho jati hai.'),
        ('Bahar jao to "Going out", aao to "I’m back"', '15 minute tak free, din mein sirf ek baar.'),
        ('Check in photo', 'Phone tedha, peeche ka camera, sir se pair tak.'),
        ('Dress', 'Somvar se Shanivar: safed upar, kala neeche, kale joote, belt.'),
        ('PIN kisi ko nahi', 'Na kisi aur ke naam se sign in.'),
        ('Galat violation?', '24 ghante ke andar "Dispute".'),
        ('My month dekhte raho', 'Mahine ke end mein koi surprise nahi.'),
        ('Group mein message nahi', 'App na chale to Aakash sir ko call.'),
    ], GREEN))

    def footer(c, d):
        c.saveState()
        c.setFont('GJ', 8)
        c.setFillColor(sg.MUTED)
        c.drawString(14 * mm, 8 * mm, 'GJ Leave & Attendance - Team Manual (A to Z)')
        c.drawRightString(A4[0] - 14 * mm, 8 * mm, 'Page %d' % d.page)
        c.restoreState()

    doc.build(s, onFirstPage=footer, onLaterPages=footer)


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'GJ_Leave_Team_Manual.pdf')
