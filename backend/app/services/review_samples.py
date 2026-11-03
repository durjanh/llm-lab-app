"""Thirty invented product reviews for Larkspur Direct, a fictional online retailer, in eight languages.

Some are there to test the analysis: a five-star rating on a complaint (R18), a review that switches from
English to German (R21), a hope for a missing feature that reads as praise (R01), and invented brands
(Lumio, Vela, Porta, Nexwave, Ardent) beside real platforms the products work with.
"""
from __future__ import annotations

RETAILER = "Larkspur Direct"
CATEGORIES = ["Smart Home", "Home Office", "Accessories", "Networking", "Laptops"]


def _r(id_: str, product: str, category: str, rating: int, verified: bool, customer: str, date: str, text: str) -> dict:
    return {"id": id_, "product": product, "category": category, "rating": rating, "verified": verified,
            "customer": customer, "date": date, "text": text}


REVIEWS: list[dict] = [
    _r("R01", "Smart Plug 2-Pack", "Smart Home", 4, True, "刘洋", "2026-10-29",
       "智能插座设置简单，用 Lumio 应用几分钟就连上了。定时功能很实用，在上海的公寓里每天晚上自动关灯。希望以后能加上能耗监测功能。"),
    _r("R02", "Smart Light Bulbs 4-Pack", "Smart Home", 4, True, "Anna Becker", "2026-10-28",
       "Die smarten Glühbirnen von Lumio sind einfach einzurichten und bieten viele Farboptionen. Die App könnte "
       "intuitiver sein, aber insgesamt ein gutes Produkt. Funktioniert auch mit Google Home."),
    _r("R03", "Smart Doorbell Camera", "Smart Home", 5, True, "Lorenzo Bianchi", "2026-10-27",
       "Eccellente campanello smart con video di alta qualità. Il rilevamento di movimento funziona benissimo anche "
       "di notte. Installato a Milano in meno di mezz'ora."),
    _r("R04", "Smart Thermostat", "Smart Home", 2, True, "Callum Reid", "2026-10-26",
       "The Vela thermostat looks lovely, but it lost the Wi-Fi connection three times in the first week and the "
       "heating stayed on all night. Support in Manchester were polite but couldn't fix it."),
    _r("R05", "Smart Speaker Mini", "Smart Home", 5, False, "Isabel Gómez", "2026-10-25",
       "Suena increíble para su tamaño. Lo uso en la cocina de mi piso en Madrid con Amazon Alexa y responde a la "
       "primera. Muy recomendable."),
    _r("R06", "Motion Sensor", "Smart Home", 3, True, "山田太郎", "2026-10-24",
       "設定は簡単でしたが、反応が少し遅いと感じます。大阪の自宅の廊下で使っていますが、たまに検知しないことがあります。"),
    _r("R07", "Cable Management Kit", "Home Office", 5, True, "Lucía Fernández", "2026-10-23",
       "Kit de gestión de cables muy completo. Incluye todo lo necesario para organizar el escritorio. Calidad "
       "excelente por el precio."),
    _r("R08", "Document Scanner Pro", "Home Office", 5, True, "Patricia Oliveira", "2026-10-22",
       "Scanner excelente para documentos. Rápido, preciso e com ótimo software de OCR. Essencial para o meu "
       "escritório em Lisboa."),
    _r("R09", "Monitor Arm Dual Mount", "Home Office", 5, True, "Priya Natarajan", "2026-10-21",
       "Perfect for my dual monitor setup. Sturdy construction and easy to adjust. Freed up a lot of desk space in "
       "my home office."),
    _r("R10", "Ergonomic Office Chair", "Home Office", 2, True, "Julien Martin", "2026-10-20",
       "Chaise confortable les premiers jours, mais l'accoudoir gauche s'est cassé au bout d'un mois. Le service "
       "client de Porta à Lyon ne répond pas à mes e-mails."),
    _r("R11", "Standing Desk Converter", "Home Office", 4, True, "Katrin Wolf", "2026-10-19",
       "Stabiler Schreibtischaufsatz, die Höhe lässt sich leicht verstellen. Der Aufbau dauerte allerdings länger "
       "als angegeben."),
    _r("R12", "LED Desk Lamp", "Home Office", 5, True, "张伟", "2026-10-18",
       "这款台灯光线柔和，不刺眼，晚上在北京加班时眼睛舒服多了。触控调光很灵敏。"),
    _r("R13", "Laptop Cooling Pad", "Accessories", 4, True, "Michael Brown", "2026-10-17",
       "Good cooling pad that reduces laptop temperature significantly. The fans are a bit noisy at maximum speed, "
       "but it's worth it for long gaming sessions."),
    _r("R14", "USB-C Hub MultiPort", "Accessories", 4, True, "Camille Dubois", "2026-10-16",
       "Très pratique avec de nombreux ports. La qualité de construction est solide. Aurait été parfait avec un "
       "port Ethernet en plus. Livré rapidement à Bordeaux."),
    _r("R15", "Wireless Charger Pad", "Accessories", 3, False, "佐藤花子", "2026-10-15",
       "充電は問題なくできますが、充電速度がやや遅いです。デザインはシンプルで良いと思います。"),
    _r("R16", "Mechanical Keyboard RGB", "Accessories", 5, True, "Tom Hughes", "2026-10-14",
       "Fantastic keyboard with excellent tactile feedback. The RGB lighting is vibrant and customisable through the "
       "Ardent app."),
    _r("R17", "Noise-Cancelling Headphones", "Accessories", 4, True, "Giulia Romano", "2026-10-13",
       "Cancellazione del rumore ottima in treno tra Roma e Napoli. La batteria dura tutta la settimana. Un po' "
       "strette dopo qualche ora."),
    _r("R18", "USB-C Charging Cable 2 m", "Accessories", 5, True, "Daniel Kim", "2026-10-12",
       "Five stars for the fast delivery, but the cable itself stopped charging my phone after two days. Very "
       "disappointed with the quality."),
    _r("R19", "Network Switch 8-Port", "Networking", 5, True, "Stefan Müller", "2026-10-11",
       "Zuverlässiger Switch mit hoher Geschwindigkeit. Kompaktes Design und läuft kühl. Ideal für kleine Büros wie "
       "unseres in München."),
    _r("R20", "Wi-Fi 6 Router Extreme", "Networking", 5, True, "Pierre Moreau", "2026-10-10",
       "Le meilleur routeur que j'ai jamais utilisé. La portée est excellente et la vitesse est impressionnante. Le "
       "Nexwave couvre toute la maison à Marseille."),
    _r("R21", "Mesh Wi-Fi System 3-Pack", "Networking", 5, False, "Lena Hoffmann", "2026-10-09",
       "Setup took ten minutes and the coverage is great. Ehrlich gesagt, das beste Mesh-System, das ich je hatte. "
       "Only wish the app showed which devices use the most data."),
    _r("R22", "Powerline Adapter", "Networking", 1, True, "Javier Ruiz", "2026-10-08",
       "La conexión se corta cada pocas horas y hay que reiniciar los adaptadores. No lo recomiendo para teletrabajar."),
    _r("R23", "Wi-Fi Range Extender", "Networking", 4, True, "Rafael Souza", "2026-10-07",
       "Melhorou muito o sinal no quarto. A configuração pelo aplicativo foi fácil, mas a velocidade cai um pouco à "
       "noite aqui em São Paulo."),
    _r("R24", "Cat 6 Ethernet Cable 5 m", "Networking", 5, True, "鈴木一郎", "2026-10-06",
       "ケーブルはしっかりしていて、通信速度も安定しています。東京のオフィスで使っていますが問題ありません。"),
    _r("R25", "Business Laptop Slim Pro", "Laptops", 4, True, "王芳", "2026-10-05",
       "非常轻薄的商务笔记本，性能稳定，续航时间长。屏幕亮度在户外可以再亮一些。"),
    _r("R26", "Convertible Laptop 2-in-1", "Laptops", 4, True, "Marco Ferri", "2026-10-04",
       "Ottimo portatile convertibile: lo schermo touch è reattivo e la penna è precisa. Peccato che si scaldi "
       "parecchio con le app pesanti."),
    _r("R27", "Gaming Laptop 16\"", "Laptops", 3, True, "Ana Costa", "2026-10-03",
       "Desempenho muito bom nos jogos, mas a ventoinha é muito barulhenta e a bateria dura menos de duas horas. "
       "Para o preço, esperava mais."),
    _r("R28", "Ardent Ultrabook 14\"", "Laptops", 5, True, "Jonas Schmidt", "2026-10-02",
       "Das Ardent Ultrabook ist leicht, schnell und der Akku hält locker einen ganzen Arbeitstag. Die Tastatur ist "
       "angenehm leise."),
    _r("R29", "Chromebook Student Edition", "Laptops", 4, True, "Sofía Navarro", "2026-10-01",
       "Perfecto para clase: arranca en segundos y pesa muy poco. La pantalla podría tener mejor resolución, pero por "
       "este precio está genial."),
    _r("R30", "Refurbished Laptop 15\"", "Laptops", 3, False, "Sophie Laurent", "2026-09-30",
       "Ordinateur reconditionné en bon état, mais la batterie ne tient que trois heures. Le vendeur à Toulouse a été "
       "très réactif."),
]
