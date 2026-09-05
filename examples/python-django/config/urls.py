from django.urls import include, path

from . import views

urlpatterns = [
    path("", include(views.weldall.urls())),
    path("api/expenses", views.expenses),
]
